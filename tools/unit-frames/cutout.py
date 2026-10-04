"""Cut a character out of its white background and export it at in-game size.
usage: python cutout.py <in> <out.png> <height>
Background = light, low-saturation pixels (white paper, grey ground or sticker shadows)
connected to the image border. White inside the black outline is kept."""
import sys
from PIL import Image, ImageChops, ImageDraw, ImageFilter


def background_mask(rgb, min_light=130, max_chroma=30):
    """L-mode mask, 255 where the pixel is border-connected background."""
    r, g, b = rgb.split()
    hi = ImageChops.lighter(ImageChops.lighter(r, g), b)
    lo = ImageChops.darker(ImageChops.darker(r, g), b)
    light = lo.point(lambda v: 255 if v >= min_light else 0)
    grey = ImageChops.subtract(hi, lo).point(lambda v: 255 if v <= max_chroma else 0)
    cand = ImageChops.multiply(light, grey)  # 255 = could be background
    # pad with a background frame so one flood from the corner reaches every border pixel
    pad = Image.new("L", (cand.width + 2, cand.height + 2), 255)
    pad.paste(cand, (1, 1))
    ImageDraw.floodfill(pad, (0, 0), 128)
    return pad.crop((1, 1, cand.width + 1, cand.height + 1)).point(lambda v: 255 if v == 128 else 0)


def cutout(src):
    im = Image.open(src).convert("RGBA")
    bg = background_mask(im.convert("RGB"))
    # 1px feather so the resized edge is not jagged
    alpha = ImageChops.invert(bg).filter(ImageFilter.GaussianBlur(0.6))
    im.putalpha(alpha)
    return im.crop(ImageChops.invert(bg).getbbox())


if __name__ == "__main__":
    src, dst, h = sys.argv[1], sys.argv[2], int(sys.argv[3])
    im = cutout(src)
    im.resize((round(im.width * h / im.height), h), Image.LANCZOS).save(dst, optimize=True)
