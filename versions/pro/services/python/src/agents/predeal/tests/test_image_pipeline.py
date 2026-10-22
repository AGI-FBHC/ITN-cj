"""Test script for the image processing pipeline."""

import sys
from pathlib import Path

# Add the src directory to the path
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

# Test imports that don't require external dependencies
from predeal.images.parser import parse_images
from predeal.images.models import ImageRef, ProcessingStatus

# Skip tests that require external dependencies
try:
    import httpx
    import pymysql
    from PIL import Image
    HAS_DEPENDENCIES = True
except ImportError:
    HAS_DEPENDENCIES = False
    print("⚠ External dependencies not installed. Skipping some tests.")
    print("  Install with: pip install httpx pymysql Pillow zai-sdk")


def test_parser(monkeypatch):
    """Test the image parser with sample content."""
    # Test HTML img tag
    html_content = '''
<div align="center">
  <img
    src="https://example.com/4-1.png"
    alt="ReAct 范式流程"
    width="90%"
  />
  <p>图 4.1 ReAct 范式流程</p>
</div>
'''
    images = parse_images(html_content)
    assert len(images) == 1
    assert images[0].source_url == "https://example.com/4-1.png"
    assert images[0].alt_text == "ReAct 范式流程"
    assert images[0].width == "90%"
    assert images[0].figure_label == "图 4.1"
    assert images[0].caption == "图 4.1 ReAct 范式流程"
    assert images[0].is_html is True
    assert images[0].occurrence_no == 1
    print("✓ HTML img tag parsing works")

    # Test Markdown image
    md_content = '''
![ReAct 范式流程](https://example.com/4-2.png)

图 4.2 Another diagram
'''
    images = parse_images(md_content)
    assert len(images) == 1
    assert images[0].source_url == "https://example.com/4-2.png"
    assert images[0].alt_text == "ReAct 范式流程"
    assert images[0].is_html is False
    print("✓ Markdown image parsing works")

    # Test multiple images
    mixed_content = '''
# Title

<img src="https://example.com/img1.png" alt="Image 1" />

Some text

![Image 2](https://example.com/img2.png)

More text

<div>
  <img src="https://example.com/img3.png" alt="Image 3" />
  <p>图 1 Image 3</p>
</div>
'''
    images = parse_images(mixed_content)
    assert len(images) == 3
    assert images[0].occurrence_no == 1
    assert images[1].occurrence_no == 2
    assert images[2].occurrence_no == 3
    print("✓ Multiple image parsing works")

    # Test skipping processed images
    # 判定"已处理"依赖运行期读取的 IMAGE_BASE_URL——测试自带该配置，
    # 不再依赖宿主 .env（CI 无 .env 曾因此失败，2026-08-20）
    monkeypatch.setenv("IMAGE_BASE_URL", "http://113.249.110.108:28901")
    processed_content = '''
<img src="http://113.249.110.108:28901/ITN/test/image.png" alt="Already processed" />
'''
    images = parse_images(processed_content)
    assert len(images) == 0
    print("✓ Skipping processed images works")


def test_models():
    """Test the data models."""
    # Test ProcessingStatus enum
    assert ProcessingStatus.PENDING.value == "pending"
    assert ProcessingStatus.PROCESSING.value == "processing"
    assert ProcessingStatus.SUCCESS.value == "success"
    assert ProcessingStatus.FAILED.value == "failed"
    print("✓ ProcessingStatus enum works")

    # Test ImageRef creation
    ref = ImageRef(
        source_url="https://example.com/test.png",
        alt_text="Test",
        caption="Figure 1",
        figure_label="图 1",
        occurrence_no=1,
        is_html=True,
    )
    assert ref.source_url == "https://example.com/test.png"
    assert ref.occurrence_no == 1
    print("✓ ImageRef creation works")


if __name__ == "__main__":
    print("Running image pipeline tests...")
    test_models()
    test_parser()
    print("\n✓ All tests passed!")

    if not HAS_DEPENDENCIES:
        print("\nNote: Some tests were skipped due to missing dependencies.")
        print("To run all tests, install dependencies:")
        print("  pip install httpx pymysql Pillow zai-sdk")
