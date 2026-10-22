# Image Processing Module

This module handles image processing for Markdown documents in the ITN Knowledge Core system.

## Features

1. **Image Path Replacement** - Downloads remote images, uploads to ITN image server, replaces URLs
2. **VLM Image Description** - Uses GLM-4.6V-Flash to generate image descriptions
3. **Image Metadata Management** - Stores metadata in `knowledge_figures` table

## Installation

Install the required dependencies:

```bash
pip install httpx pymysql Pillow zai-sdk
```

## Configuration

All configuration is loaded from the `.env` file in the project root. Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

See `.env.example` for the full list of environment variables.

## Usage

### CLI Command

```bash
# Process images in a document
predeal figures \
  --document-id 123 \
  --source-path /path/to/document.md \
  --storage-prefix ITN/hello_agents/chapter4
```

### Python API

```python
from pathlib import Path
from predeal.images.pipeline import process_markdown_images

# Process images
output_path = process_markdown_images(
    document_id=123,
    source_path=Path("/path/to/document.md"),
    storage_prefix="ITN/hello_agents/chapter4",
)

print(f"Normalized document: {output_path}")
```

## Module Structure

```
predeal/images/
├── __init__.py          # Module initialization
├── models.py            # Data models
├── parser.py            # Image identification
├── downloader.py        # Remote image download
├── inspector.py         # Image validation
├── uploader.py          # Upload to image server
├── vlm.py               # VLM API integration
├── repository.py        # Database operations
├── rewriter.py          # Document rewriting
└── pipeline.py          # Main orchestration
```

## Database Schema

The module uses the `knowledge_figures` table with the following key fields:

- `document_id` - Document ID
- `occurrence_no` - Image order in document (1-based)
- `source_url` - Original image URL
- `storage_key` - Server storage path
- `sha256` - File hash
- `vlm_description` - VLM generated description
- `download_status`, `upload_status`, `vlm_status` - Processing status

## Processing Flow

1. Parse images from Markdown document
2. Create/update database records
3. Download remote images to temporary files
4. Validate images (format, size, dimensions)
5. Upload to ITN image server
6. Generate VLM descriptions
7. Update database records
8. Replace image URLs in document
9. Write normalized document

## Error Handling

- Each processing step has independent status tracking
- Failed steps are recorded in the database
- Temporary files are cleaned up even on error
- Original documents are never modified
