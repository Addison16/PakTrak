# Test fixtures

`transport.png` is a generated image labeled “SYNTHETIC TEST / NO CARD DATA.”
It exercises photo upload, background preparation, and browser recovery only.
It contains no MTG reference artwork, real collection data, or recognition evidence.

`photos/` contains codec variants generated from `transport.png`, a synthetic
two-image HEIC with a rotated primary image at index 1, a JPEG with MPF auxiliary
image data, and 10/12-bit gray patches. The MPF fixture reproduces a still camera
JPEG being exposed as a multi-image MPO; it is not a calibrated HDR gain map.
`photos/sha256.json` records the current files. Regenerate with
`uv run --no-project --with Pillow==12.3.0 --with pillow-heif==1.7.0 python tests/fixtures/generate_photos.py`
in the pinned Python 3.13 container. The encoder is needed only to regenerate fixtures;
the application uses the decoding-only `pi-heif`. All pixels and metadata in these
fixtures are synthetic. No external compatibility samples belong in this folder;
downloaded upstream samples remain in ignored local artifacts.
# Collection and geometry fixtures

The collection integration suite creates clearly named synthetic printings in the isolated test database. Its CSV rows, quantities, binder names, and notes are generated test data, not exports from ManaBox or anyone's actual holdings. Geometry tests draw simple rectangles; they are not recognition-accuracy evidence.

The browser transfer test uses printing IDs from the operator-provisioned local Scryfall catalog with synthetic owned quantities in disposable test accounts. That checks live catalog resolution and the app workflow; it does not certify a third-party CSV format or destination import.

`deck-1.jpg` and `deck-2.jpg` are original 1000×700 synthetic geometry fixtures for live photo-to-deck tests. Each has two 180×252 pale rectangles with a five-pixel black edge, positioned at (120,120) and (560,120), containing solid purple art rectangles. Background colors are RGB (51,70,51) and (51,71,51). Pillow generated the JPEGs. They contain no card text or copyrighted artwork, and are used for durable processing and reviewed deck saves, not recognition-accuracy claims.
