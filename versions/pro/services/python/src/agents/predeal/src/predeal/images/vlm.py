"""VLM (Vision Language Model) integration for image description.

Uses GLM-4.6V-Flash from Zhipu AI to generate image descriptions.
"""
from __future__ import annotations
import base64
import logging
import os
import time
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# Default prompt for image description
DEFAULT_PROMPT = (
    "请客观描述这张图片中的内容。"
    "如果是流程图，说明主要节点和流程方向；"
    "如果是表格，概括主要对比维度和结论；"
    "如果是架构图，说明主要组件及关系。"
    "不要补充图片中不存在的信息。"
    "使用中文，控制在100到300字，"
    "只输出描述正文。"
)


def describe_image(
    image_path: Path,
    api_key: Optional[str] = None,
    model: Optional[str] = None,
    prompt: Optional[str] = None,
) -> str:
    """Generate a description of an image using VLM.

    Args:
        image_path: Path to the local image file
        api_key: Zhipu AI API key (default: from env)
        model: VLM model name (default: from env)
        prompt: Custom prompt for description (default: standard prompt)

    Returns:
        Generated image description text

    Raises:
        FileNotFoundError: If the image file does not exist
        ValueError: If the API key is not set or description is empty
        Exception: If the API call fails
    """
    if api_key is None:
        api_key = os.environ.get("ZAI_API_KEY", "")

    if model is None:
        model = os.environ.get("VLM_MODEL", "glm-4.6v-flash")

    if prompt is None:
        prompt = DEFAULT_PROMPT

    if not api_key:
        raise ValueError(
            "ZAI_API_KEY not set. Set the environment variable or pass api_key."
        )

    if not image_path.exists():
        raise FileNotFoundError(f"Image file not found: {image_path}")

    logger.info(f"Generating VLM description for: {image_path}")

    # Determine MIME type from extension
    _ext_to_mime = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
    }
    mime = _ext_to_mime.get(image_path.suffix.lower(), "image/png")

    # Encode image to base64 with data URI prefix
    raw_b64 = base64.b64encode(image_path.read_bytes()).decode("utf-8")
    image_base64 = f"data:{mime};base64,{raw_b64}"

    # Retry configuration
    max_retries = 3
    retry_delay = 3.0  # seconds between retries

    try:
        # Import SDK
        from zai import ZhipuAiClient

        # Create client
        client = ZhipuAiClient(api_key=api_key)

        # Make API call with retry for rate limiting
        last_error = None
        for attempt in range(1, max_retries + 1):
            try:
                response = client.chat.completions.create(
                    model=model,
                    messages=[
                        {
                            "role": "user",
                            "content": [
                                {
                                    "type": "image_url",
                                    "image_url": {
                                        "url": image_base64,
                                    },
                                },
                                {
                                    "type": "text",
                                    "text": prompt,
                                },
                            ],
                        }
                    ],
                    thinking={
                        "type": "disabled",
                    },
                )

                # Extract description
                description = response.choices[0].message.content

                if not description or not description.strip():
                    raise ValueError("VLM returned empty description")

                # Clean up the description
                cleaned = _clean_description(description)

                logger.info(
                    f"Generated VLM description: {len(cleaned)} chars"
                )
                return cleaned

            except Exception as e:
                last_error = e
                # Check if it's a rate limit error (429)
                err_str = str(e)
                if "429" in err_str or "rate" in err_str.lower() or "访问量过大" in err_str:
                    if attempt < max_retries:
                        wait = retry_delay * attempt
                        logger.warning(
                            f"VLM rate limited (attempt {attempt}/{max_retries}), "
                            f"waiting {wait}s before retry..."
                        )
                        time.sleep(wait)
                        continue
                raise  # Non-rate-limit errors propagate immediately

        # All retries exhausted
        raise last_error

    except ImportError:
        raise ImportError(
            "zai-sdk not installed. Install with: pip install zai-sdk"
        )
    except Exception as e:
        logger.error(f"VLM API call failed: {e}")
        raise


def _clean_description(description: str) -> str:
    """Clean and normalize VLM description.

    - Remove markdown code blocks
    - Normalize whitespace
    - Remove leading/trailing whitespace

    Args:
        description: Raw description from VLM

    Returns:
        Cleaned description
    """
    # Remove markdown code blocks if present
    if description.startswith("```"):
        lines = description.split("\n")
        # Remove first and last lines if they are code fences
        if len(lines) > 2:
            if lines[0].startswith("```") and lines[-1].strip() == "```":
                description = "\n".join(lines[1:-1])

    # Normalize whitespace: collapse multiple spaces and newlines
    import re
    description = re.sub(r'\s+', ' ', description)

    return description.strip()
