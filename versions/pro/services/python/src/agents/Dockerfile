FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
ARG PIP_INDEX_URL=https://pypi.org/simple
RUN apt-get update \
    && apt-get install -y --no-install-recommends libreoffice-impress poppler-utils fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt ./
RUN pip install --no-cache-dir --index-url "${PIP_INDEX_URL}" -r requirements.txt
COPY app ./app
COPY main.py ./
RUN addgroup --system itn && adduser --system --ingroup itn itn \
    && mkdir -p /data && chown -R itn:itn /app /data
USER itn
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
