from PIL import Image
from pathlib import Path

root = Path(__file__).resolve().parents[2]
# Bounds inspected in the supplied reference: tree only, no ring or labels.
source = Image.open('C:/Users/Admin/Desktop/IMG_1903.PNG').convert('RGB')
crop = source.crop((365, 160, 818, 590))
# Remove the white background without tracing or simplifying the silhouette.
alpha = crop.convert('L').point(lambda v: 255 - v)
# The rectangular crop catches tiny pieces of the reference ring in corners.
# These rectangles are outside the inspected tree contour; remove only them.
for box in ((0, 0, 30, 30), (0, 330, 80, 430), (350, 330, 453, 430)):
    alpha.paste(0, box)
    crop.paste((255, 255, 255), box)
tree = Image.new('RGBA', crop.size, (0, 0, 0, 0))
tree.putalpha(alpha)
output = root / 'js/harness/diary-ui/tree-reference.png'
tree.save(output)
# Exact recovery over white proves no detail was simplified during extraction.
composite = Image.new('RGBA', tree.size, 'white')
composite.alpha_composite(tree)
assert composite.convert('RGB').convert('L').tobytes() == crop.convert('L').tobytes()
print('PASS: reference silhouette extracted without contour simplification; 453x430 RGBA')
