#!/usr/bin/env python3
"""Copy the supplied logo and prepare desktop icons using Pillow and local Tauri.

Run with --logo-input and --icon-input pointing to the original supplied PNGs.
Only the logo asset, public icon, and existing desktop icon filenames are written.
"""

import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image


NATIVE_ICON_FILES = (
    "32x32.png",
    "128x128.png",
    "128x128@2x.png",
    "icon.png",
    "icon.ico",
    "icon.icns",
    "Square30x30Logo.png",
    "Square44x44Logo.png",
    "Square71x71Logo.png",
    "Square89x89Logo.png",
    "Square107x107Logo.png",
    "Square142x142Logo.png",
    "Square150x150Logo.png",
    "Square284x284Logo.png",
    "Square310x310Logo.png",
    "StoreLogo.png",
)


def normalized_icon(source: Path, size: int, padding: float, cutoff: int):
    with Image.open(source) as original:
        image = original.convert("RGBA")
    # Preserve RGB and retained alpha values; discard only almost invisible noise.
    alpha = image.getchannel("A").point(lambda value: value if value >= cutoff else 0)
    bounds = alpha.getbbox()
    if bounds is None:
        raise ValueError("The icon contains no artwork above the alpha cutoff.")
    image.putalpha(alpha)
    artwork = image.crop(bounds)
    available = round(size * (1 - 2 * padding))
    if available < 1:
        raise ValueError("Padding leaves no room for the artwork.")
    scale = available / max(artwork.size)
    dimensions = tuple(max(1, round(side * scale)) for side in artwork.size)
    artwork = artwork.resize(dimensions, Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    offset = tuple((size - side) // 2 for side in artwork.size)
    canvas.alpha_composite(artwork, offset)
    return canvas, bounds


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--logo-input", type=Path, required=True)
    parser.add_argument("--icon-input", type=Path, required=True)
    parser.add_argument("--size", type=int, choices=(512, 1024), default=1024)
    parser.add_argument("--padding", type=float, default=0.06,
                        help="Transparent padding per side, as a canvas fraction (default: 0.06).")
    parser.add_argument("--alpha-cutoff", type=int, default=16,
                        help="Discard source alpha below this value (default: 16/255).")
    parser.add_argument("--node", default="node", help="Node executable (default: node).")
    args = parser.parse_args()
    if not 0 <= args.padding < 0.5:
        parser.error("--padding must be at least 0 and less than 0.5")
    if not 1 <= args.alpha_cutoff <= 255:
        parser.error("--alpha-cutoff must be between 1 and 255")
    for source in (args.logo_input, args.icon_input):
        if not source.is_file():
            parser.error(f"Input file does not exist: {source}")

    root = Path(__file__).resolve().parent.parent
    cli = root / "node_modules/@tauri-apps/cli/tauri.js"
    if not cli.is_file():
        parser.error("The local Tauri CLI is missing; install the repository dependencies first.")
    node = shutil.which(args.node)
    if node is None:
        parser.error(f"Node executable not found: {args.node}")

    logo_output = root / "src/assets/cozynotes-logo.png"
    icon_output = root / "public/cozynotes-icon.png"
    icons_directory = root / "src-tauri/icons"
    canvas, source_bounds = normalized_icon(
        args.icon_input, args.size, args.padding, args.alpha_cutoff
    )
    for directory in (logo_output.parent, icon_output.parent, icons_directory):
        directory.mkdir(parents=True, exist_ok=True)

    # Stage only beneath the permitted native asset directory. Tauri also makes
    # mobile icons; publish the existing desktop filenames and discard the rest.
    with tempfile.TemporaryDirectory(prefix=".prepare-brand-", dir=icons_directory) as temporary:
        staging = Path(temporary).resolve()
        if staging.parent != icons_directory.resolve():
            raise ValueError("The staging directory must stay inside src-tauri/icons.")
        staged_source = staging / "normalized-source.png"
        staged_icons = staging / "generated"
        canvas.save(staged_source)
        subprocess.run(
            [node, str(cli), "icon", str(staged_source), "--output", str(staged_icons)],
            cwd=root,
            check=True,
        )
        for name in NATIVE_ICON_FILES:
            if not (staged_icons / name).is_file():
                raise FileNotFoundError(f"Tauri did not generate the required desktop icon: {name}")
        shutil.copyfile(args.logo_input, logo_output)
        shutil.copyfile(staged_source, icon_output)
        for name in NATIVE_ICON_FILES:
            shutil.copyfile(staged_icons / name, icons_directory / name)

    if args.logo_input.read_bytes() != logo_output.read_bytes():
        raise ValueError("The copied logo must match the supplied file byte for byte.")
    print(json.dumps({
        "logo_sha256": hashlib.sha256(logo_output.read_bytes()).hexdigest(),
        "source_crop_bounds": source_bounds,
        "alpha_cutoff": args.alpha_cutoff,
        "output_dimensions": canvas.size,
        "output_nontransparent_bounds": canvas.getchannel("A").getbbox(),
        "native_files": list(NATIVE_ICON_FILES),
    }, indent=2))


if __name__ == "__main__":
    main()
