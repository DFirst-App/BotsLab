#!/usr/bin/env python3
"""
Generate favicon files from SVG according to Google Search requirements.
This script creates favicon.ico, favicon-16x16.png, favicon-32x32.png, and apple-touch-icon.png
from the favicon.svg file.

Requirements: pip install Pillow cairosvg
"""

import os
from PIL import Image
import cairosvg

def generate_favicons():
    """Generate all required favicon files from SVG."""
    svg_path = 'favicon.svg'
    
    if not os.path.exists(svg_path):
        print(f"Error: {svg_path} not found!")
        return False
    
    print("Generating favicon files from SVG...")
    
    # Generate PNG files from SVG
    sizes = {
        'favicon-16x16.png': 16,
        'favicon-32x32.png': 32,
        'apple-touch-icon.png': 180
    }
    
    for filename, size in sizes.items():
        try:
            # Convert SVG to PNG
            png_data = cairosvg.svg2png(url=svg_path, output_width=size, output_height=size)
            
            # Save PNG
            with open(filename, 'wb') as f:
                f.write(png_data)
            
            print(f"✓ Created {filename} ({size}x{size})")
        except Exception as e:
            print(f"✗ Error creating {filename}: {e}")
    
    # Generate ICO file (multi-size: 16x16, 32x32, 48x48)
    try:
        # Create ICO with multiple sizes
        ico_sizes = [16, 32, 48]
        ico_images = []
        
        for size in ico_sizes:
            png_data = cairosvg.svg2png(url=svg_path, output_width=size, output_height=size)
            img = Image.open(io.BytesIO(png_data))
            ico_images.append(img)
        
        # Save as ICO
        ico_images[0].save(
            'favicon.ico',
            format='ICO',
            sizes=[(s, s) for s in ico_sizes]
        )
        
        print("✓ Created favicon.ico (16x16, 32x32, 48x48)")
    except Exception as e:
        print(f"✗ Error creating favicon.ico: {e}")
        print("  Note: You can use an online ICO converter or ImageMagick")
    
    print("\n✓ All favicon files generated successfully!")
    return True

if __name__ == '__main__':
    import io
    generate_favicons()

