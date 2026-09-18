"""Build the self-hosted LiveNest font subset from an OFL-licensed Noto Sans SC variable TTF."""
import argparse
import hashlib
from pathlib import Path
from fontTools import subset
from fontTools.ttLib import TTFont


def build(source: Path, destination: Path):
    """Retain GB2312, Latin, punctuation and current UI glyphs; preserve OFL metadata."""
    chars = set(range(0x20, 0x250)) | set(range(0x2000, 0x2070))
    for high in range(0xA1, 0xF8):
        for low in range(0xA1, 0xFF):
            try:
                chars.update(map(ord, bytes([high, low]).decode('gb2312')))
            except UnicodeDecodeError:
                pass
    for file in Path('src').rglob('*'):
        if file.suffix in {'.ts', '.tsx'}:
            chars.update(map(ord, file.read_text(encoding='utf-8')))
    font = TTFont(source)
    options = subset.Options()
    options.hinting = False
    options.name_IDs = ['*']
    options.name_legacy = True
    options.name_languages = ['*']
    sub = subset.Subsetter(options=options)
    sub.populate(unicodes=chars)
    sub.subset(font)
    # A distinct family name identifies this derived subset while retaining copyright/license.
    for record in font['name'].names:
        if record.nameID in {1, 4, 6, 16}:
            name = 'LiveNestSansSC' if record.nameID == 6 else 'LiveNest Sans SC'
            record.string = name.encode(record.getEncoding())
    font.flavor = 'woff2'
    font.save(destination)
    print('Source SHA256: ' + hashlib.sha256(source.read_bytes()).hexdigest())
    print('Saved ' + str(destination) + ': ' + str(destination.stat().st_size) + ' bytes')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    build(args.source, args.destination)
