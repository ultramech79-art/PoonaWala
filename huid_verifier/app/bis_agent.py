"""
BIS CARE Appium automation agent.

Launches the BIS CARE Android app, navigates to HUID verification,
enters the HUID, waits for the result screen, captures page source +
screenshot, then always quits the driver.

Selector strategy (in priority order):
  1. resource-id (stable across app updates)
  2. accessibility id / content-desc
  3. Android UiAutomator textContains / className
  4. XPath (last resort, never used here)
"""
import os
import time
from dataclasses import dataclass
from typing import Optional

# Ensure Android SDK env vars are set regardless of how the process was launched
_SDK = os.path.expanduser("~/Library/Android/sdk")
os.environ.setdefault("ANDROID_HOME", _SDK)
os.environ.setdefault("ANDROID_SDK_ROOT", _SDK)

from appium import webdriver
from appium.options.android import UiAutomator2Options
from appium.webdriver.common.appiumby import AppiumBy
from selenium.common.exceptions import NoSuchElementException, TimeoutException
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

from app.config import settings
from app.logging_config import get_logger

logger = get_logger("huid_verifier.bis_agent")
_driver: Optional[webdriver.Remote] = None


# ─── Result container ──────────────────────────────────────────────────────────
@dataclass
class AgentResult:
    raw_text: str
    screenshot_path: Optional[str]
    error: Optional[str]


# ─── Selector helpers ──────────────────────────────────────────────────────────

def find_by_text_contains(driver: webdriver.Remote, text: str):
    """Return first element whose visible text contains *text* (case-insensitive)."""
    locator = f'new UiSelector().textContains("{text}")'
    return driver.find_element(AppiumBy.ANDROID_UIAUTOMATOR, locator)


def click_first_matching_text(driver: webdriver.Remote, possible_texts: list[str]) -> bool:
    """
    Try each text in *possible_texts* and click the first match.
    Returns True if a match was found and clicked.
    """
    for text in possible_texts:
        try:
            el = find_by_text_contains(driver, text)
            el.click()
            logger.info("Clicked element with text containing '%s'", text)
            return True
        except NoSuchElementException:
            continue
    return False


def click_reset_if_present(driver: webdriver.Remote) -> bool:
    """Clear a previous HUID result if the app is already on the result screen."""
    try:
        reset_button = find_by_text_contains(driver, "RESET")
        reset_button.click()
        logger.info("Clicked RESET to clear previous result")
        time.sleep(1.0)
        return True
    except NoSuchElementException:
        return False


def find_first_edit_text(driver: webdriver.Remote):
    """Return the first EditText input field on screen."""
    locator = 'new UiSelector().className("android.widget.EditText").instance(0)'
    return driver.find_element(AppiumBy.ANDROID_UIAUTOMATOR, locator)


def find_huid_input(driver: webdriver.Remote, timeout: int):
    """Return the BIS CARE HUID input field, preferring the app's stable id."""
    try:
        return _wait_for_element(driver, AppiumBy.ID, "com.bis.bisapp:id/HUID_no_edit_text", timeout)
    except TimeoutException:
        return _wait_for_element(
            driver,
            AppiumBy.ANDROID_UIAUTOMATOR,
            'new UiSelector().className("android.widget.EditText").instance(0)',
            timeout,
        )


def dump_page_source(driver: webdriver.Remote, output_path: str) -> None:
    """Write driver.page_source to *output_path* for offline debugging."""
    try:
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as fh:
            fh.write(driver.page_source)
        logger.debug("Page source dumped to %s", output_path)
    except Exception as exc:
        logger.warning("Could not dump page source: %s", exc)


def _wait_for_element(driver: webdriver.Remote, by: str, value: str, timeout: int):
    """Wait up to *timeout* seconds for an element to be present."""
    return WebDriverWait(driver, timeout).until(
        EC.presence_of_element_located((by, value))
    )


# ─── Screenshot helper ─────────────────────────────────────────────────────────

def _save_screenshot(driver: webdriver.Remote, huid: str) -> Optional[str]:
    os.makedirs(settings.screenshots_dir, exist_ok=True)
    filename = f"{huid}_{int(time.time())}.png"
    path = os.path.join(settings.screenshots_dir, filename)
    try:
        driver.save_screenshot(path)
        logger.info("Screenshot saved: %s", path)
        return path
    except Exception as exc:
        logger.warning("Screenshot failed: %s", exc)
        return None


# ─── Core automation ───────────────────────────────────────────────────────────

def _build_driver() -> webdriver.Remote:
    opts = UiAutomator2Options()
    opts.platform_name = "Android"
    opts.device_name = settings.device_name
    opts.udid = settings.device_udid
    opts.app_package = settings.bis_package
    # If activity is configured use it; otherwise let Appium resolve the launcher
    if settings.bis_activity:
        opts.app_activity = settings.bis_activity
    opts.no_reset = True
    opts.full_reset = False
    opts.new_command_timeout = settings.appium_new_command_timeout
    opts.auto_grant_permissions = True
    opts.set_capability("uiautomator2ServerLaunchTimeout", 60000)
    opts.set_capability("uiautomator2ServerInstallTimeout", 60000)
    opts.set_capability("adbExecTimeout", 60000)

    logger.info(
        "Starting Appium session — device=%s udid=%s package=%s",
        settings.device_name,
        settings.device_udid,
        settings.bis_package,
    )
    driver = webdriver.Remote(settings.appium_url, options=opts)
    logger.info("Appium session started — session_id=%s", driver.session_id)
    return driver


def _get_driver() -> webdriver.Remote:
    """Reuse one Appium session so each HUID check avoids session startup cost."""
    global _driver
    if _driver is not None:
        try:
            _driver.current_package
            return _driver
        except Exception as exc:
            logger.warning("Existing Appium session is not usable; rebuilding: %s", exc)
            try:
                _driver.quit()
            except Exception:
                pass
            _driver = None

    _driver = _build_driver()
    return _driver


def close_driver() -> None:
    """Close the cached Appium session during API shutdown or manual cleanup."""
    global _driver
    if _driver is not None:
        try:
            _driver.quit()
            logger.info("Appium driver quit cleanly")
        except Exception as exc:
            logger.warning("Driver quit failed: %s", exc)
        finally:
            _driver = None


def _mark_driver_failed() -> None:
    global _driver
    if _driver is not None:
        try:
            _driver.quit()
        except Exception:
            pass
        _driver = None


def verify_huid_via_app(huid: str) -> AgentResult:
    """
    Full vertical slice:
      open BIS CARE → tap Verify HUID → enter HUID → tap Search → capture result.

    Returns AgentResult with raw_text and screenshot_path.
    """
    try:
        driver = _get_driver()
        wait = settings.element_wait_timeout

        # ── 1. Navigate to HUID verification screen ───────────────────────────
        try:
            input_field = find_huid_input(driver, timeout=3)
            logger.info("HUID form already open")
        except TimeoutException:
            logger.info("Looking for HUID entry button")
            huid_entry_texts = ["Verify HUID", "HUID Verification", "Verify Hallmark"]
            found = click_first_matching_text(driver, huid_entry_texts)
            if not found:
                # Try scrollable list in case entry is below the fold
                try:
                    locator = (
                        'new UiScrollable(new UiSelector().scrollable(true))'
                        '.scrollIntoView(new UiSelector().textContains("HUID"))'
                    )
                    el = driver.find_element(AppiumBy.ANDROID_UIAUTOMATOR, locator)
                    el.click()
                    logger.info("Scrolled and clicked HUID menu item")
                except NoSuchElementException:
                    logger.warning("HUID entry button not found — attempting to continue from current screen")

            input_field = find_huid_input(driver, timeout=wait)

        # Dismiss lingering "invalid HUID" dialog from a previous failed search
        try:
            find_by_text_contains(driver, "HUID number appears to be invalid")
            click_first_matching_text(driver, ["ENTER CORRECT HUID NUMBER", "ENTER CORRECT", "OK"])
            time.sleep(0.5)
            logger.info("Cleared lingering invalid-HUID dialog")
        except NoSuchElementException:
            pass

        if click_reset_if_present(driver):
            input_field = find_huid_input(driver, timeout=wait)

        # ── 2. Enter HUID in the input field ─────────────────────────────────
        logger.info("Entering HUID")
        input_field.click()
        input_field.clear()
        input_field.send_keys(huid)
        logger.info("Entered HUID: %s", huid)

        # ── 3. Submit ─────────────────────────────────────────────────────────
        logger.info("Looking for submit/search button")
        try:
            submit_button = _wait_for_element(driver, AppiumBy.ID, "com.bis.bisapp:id/go_text_view", timeout=3)
            submit_button.click()
            found = True
            logger.info("Clicked Search button by id")
        except TimeoutException:
            submit_texts = ["Search", "Get Details", "Submit", "Verify", "Check"]
            found = click_first_matching_text(driver, submit_texts)
        if not found:
            # Fallback: tap keyboard Search action
            try:
                input_field.submit()
                logger.info("Used input field submit() as fallback")
            except Exception:
                logger.warning("Could not find submit button — result may be incomplete")

        # ── 4. Wait for result screen ─────────────────────────────────────────
        logger.info("Waiting for result screen (up to %ds)", settings.result_wait_timeout)
        try:
            WebDriverWait(driver, settings.result_wait_timeout).until(
                EC.any_of(
                    EC.presence_of_element_located((AppiumBy.ID, "com.bis.bisapp:id/results_card")),
                    EC.presence_of_element_located((AppiumBy.ID, "com.bis.bisapp:id/getLicDetailsResetBtn")),
                    EC.presence_of_element_located(
                        (
                            AppiumBy.ANDROID_UIAUTOMATOR,
                            'new UiSelector().textContains("not found")',
                        )
                    ),
                    EC.presence_of_element_located(
                        (
                            AppiumBy.ANDROID_UIAUTOMATOR,
                            'new UiSelector().textContains("Invalid")',
                        )
                    ),
                )
            )
        except TimeoutException:
            logger.warning("Timed out waiting for a clear result marker; capturing current screen")

        # ── 5. Detect "invalid HUID" dialog ──────────────────────────────────
        try:
            invalid_el = find_by_text_contains(driver, "HUID number appears to be invalid")
            # Dialog is showing — tap the dismiss button and reset session
            logger.info("Invalid HUID dialog detected — dismissing")
            click_first_matching_text(driver, [
                "ENTER CORRECT HUID NUMBER", "ENTER CORRECT", "OK", "CLOSE",
            ])
            time.sleep(0.3)
            _mark_driver_failed()  # Force fresh session next call
            return AgentResult(raw_text="HUID not found", screenshot_path=None, error=None)
        except NoSuchElementException:
            pass  # No dialog — normal result screen

        # ── 6. Capture before scroll (Jeweller Details visible) ──────────────
        raw_text_top = driver.page_source

        # ── 6. Scroll down twice to reveal Article Details (purity, date) ───
        try:
            size = driver.get_window_size()
            cx = size["width"] // 2
            # First swipe
            driver.swipe(cx, int(size["height"] * 0.75), cx, int(size["height"] * 0.25), duration=400)
            time.sleep(0.6)
            # Second swipe to get past RESET button into Article Details
            driver.swipe(cx, int(size["height"] * 0.75), cx, int(size["height"] * 0.25), duration=400)
            time.sleep(1.2)
        except Exception as e:
            logger.warning("Scroll failed: %s", e)

        # ── 7. Merge both page sources for complete parsing ───────────────────
        raw_text_bottom = driver.page_source
        raw_text = raw_text_top + "\n" + raw_text_bottom
        screenshot_path = None
        if settings.save_debug_artifacts:
            screenshot_path = _save_screenshot(driver, huid)
            dump_page_source(
                driver,
                os.path.join(settings.screenshots_dir, f"{huid}_{int(time.time())}_source.xml"),
            )

        logger.info("Captured result screen — raw_text length=%d", len(raw_text))
        return AgentResult(raw_text=raw_text, screenshot_path=screenshot_path, error=None)

    except Exception as exc:
        logger.exception("BIS agent error for HUID %s: %s", huid, exc)
        screenshot_path = None
        driver = _driver
        if driver and settings.save_debug_artifacts:
            screenshot_path = _save_screenshot(driver, f"error_{huid}")
        _mark_driver_failed()
        return AgentResult(raw_text="", screenshot_path=screenshot_path, error=str(exc))
