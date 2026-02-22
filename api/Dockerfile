FROM python:3.11-slim

# System libs needed by OpenCV + PyMuPDF
RUN apt-get update -qq && apt-get install -y -qq     libgl1 libglib2.0-0   && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

COPY app /app/app

ENV PYTHONUNBUFFERED=1

EXPOSE 8000
CMD ["python", "-m", "app.server"]
