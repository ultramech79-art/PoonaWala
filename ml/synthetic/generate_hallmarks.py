import os
import random
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

def generate_gold_texture(width, height):
    # Base gold color
    base_color = (255, 215, 0) # Gold
    img = Image.new('RGB', (width, height), base_color)
    pixels = img.load()
    
    # Add some variation
    for x in range(width):
        for y in range(height):
            # Randomly shift color slightly
            r = min(255, max(0, base_color[0] + random.randint(-30, 30)))
            g = min(255, max(0, base_color[1] + random.randint(-30, 30)))
            b = min(255, max(0, base_color[2] + random.randint(-10, 10)))
            pixels[x, y] = (r, g, b)
            
    # Apply some blur to smooth the noise
    img = img.filter(ImageFilter.GaussianBlur(radius=2))
    return img

def add_hallmark(image, text):
    draw = ImageDraw.Draw(image)
    width, height = image.size
    
    # Random font size
    font_size = random.randint(20, 60)
    try:
        # Try to use a standard font, fallback to default
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", font_size)
    except:
        font = ImageFont.load_default()
        
    # Random position
    x = random.randint(0, width - 100)
    y = random.randint(0, height - 100)
    
    # Hallmark color (usually slightly darker/pressed look)
    hallmark_color = (180, 150, 0, 150) # Semi-transparent
    
    # Draw text
    draw.text((x, y), text, fill=hallmark_color, font=font)
    
    # Add some "embossed" effect by drawing a slight shadow
    draw.text((x-1, y-1), text, fill=(100, 80, 0, 100), font=font)
    
    return image

def generate_hallmark_dataset(output_dir, num_samples=1000):
    os.makedirs(os.path.join(output_dir, "hallmark"), exist_ok=True)
    os.makedirs(os.path.join(output_dir, "no_hallmark"), exist_ok=True)
    
    hallmark_texts = ["916", "22K", "18K", "BIS", "HUID", "750"]
    
    for i in range(num_samples):
        width, height = 256, 256
        img = generate_gold_texture(width, height)
        
        # 50% chance to have a hallmark
        if random.random() > 0.5:
            text = random.choice(hallmark_texts)
            img = add_hallmark(img, text)
            # Add some perspective transform or rotation
            img = img.rotate(random.randint(-10, 10))
            img.save(os.path.join(output_dir, "hallmark", f"hallmark_{i}.jpg"))
        else:
            img.save(os.path.join(output_dir, "no_hallmark", f"no_hallmark_{i}.jpg"))
            
    print(f"Generated {num_samples} synthetic hallmark samples in {output_dir}")

if __name__ == "__main__":
    generate_hallmark_dataset("ml/synthetic/hallmarks", num_samples=1000)
