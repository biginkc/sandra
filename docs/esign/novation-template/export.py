"""Export both novation packet variants with page numbers.

Requires Chrome, pypdf, and reportlab. Run from this directory or by path.
"""

from io import BytesIO
from pathlib import Path
import os
import subprocess

from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parent
CHROME = os.environ.get(
    "CHROME_BIN", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
)
VARIANTS = (
    ("index.html", "novation-packet-blank.pdf"),
    ("index-two-sellers.html", "novation-packet-two-sellers.pdf"),
)


def export(source_name: str, output_name: str) -> None:
    source = ROOT / source_name
    output = ROOT / output_name
    raw = ROOT / f".{output_name}.raw.pdf"
    try:
        subprocess.run(
            [
                CHROME,
                "--headless=new",
                "--disable-gpu",
                "--no-sandbox",
                "--no-pdf-header-footer",
                "--virtual-time-budget=12000",
                f"--print-to-pdf={raw}",
                source.as_uri(),
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=45,
        )
        reader = PdfReader(raw)
        if len(reader.pages) != 7:
            raise ValueError(f"{source_name} exported {len(reader.pages)} pages, expected 7")
        if "RESIDENTIAL REAL ESTATE" not in reader.pages[0].extract_text():
            raise ValueError("Purchase agreement is not on page 1")
        for number, heading in (
            (5, "LIMITED POWER OF ATTORNEY"),
            (6, "ADDENDUM TO PURCHASE AND SALE AGREEMENT"),
            (7, "RESCISSION AND RELEASE"),
        ):
            if heading not in reader.pages[number - 1].extract_text():
                raise ValueError(f"{heading} is not on page {number}")

        writer = PdfWriter()
        for index, page in enumerate(reader.pages, start=1):
            width = float(page.mediabox.width)
            height = float(page.mediabox.height)
            overlay = BytesIO()
            layer = canvas.Canvas(overlay, pagesize=(width, height))
            layer.setFillColorRGB(0.478, 0.443, 0.416)
            layer.setFont("Helvetica", 8.5)
            page_label = f"Page {index} of 4" if index <= 4 else "Page 1 of 1"
            layer.drawRightString(width - 51, 28, page_label)
            layer.save()
            overlay.seek(0)
            page.merge_page(PdfReader(overlay).pages[0])
            writer.add_page(page)
        with output.open("wb") as stream:
            writer.write(stream)
        print(f"Exported {output.name}: {len(reader.pages)} numbered pages")
    finally:
        raw.unlink(missing_ok=True)


if __name__ == "__main__":
    for variant in VARIANTS:
        export(*variant)
