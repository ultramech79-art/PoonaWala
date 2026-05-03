{ pkgs }: {
  deps = [
    pkgs.python311
    pkgs.postgresql
    pkgs.python311Packages.pip
  ];

  env = {
    PYTHONBIN = "${pkgs.python311}/bin/python3.11";
    LANG = "en_US.UTF-8";
    LOCALE_ARCHIVE = "${pkgs.glibcLocales}/lib/locale/locale-archive";
  };

  postInstall = ''
    export PIP_USER=false
    export PIP_BREAK_SYSTEM_PACKAGES=true
    pip install -r requirements.txt
  '';
}
