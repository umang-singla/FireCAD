FROM python:3.11-slim

# System libs needed by OpenCV + PyMuPDF
RUN apt-get update -qq && apt-get install -y -qq \
		ca-certificates \
	fontconfig \
	libfreetype6 \
		libgl1 \
		libglib2.0-0 \
		libxcb-icccm4 \
		libxcb-image0 \
		libxcb-keysyms1 \
		libxcb-render-util0 \
		libxcb-render0 \
		libxcb-shape0 \
		libxcb-xkb1 \
		libxkbcommon-x11-0 \
	libpng16-16 \
	libxkbcommon0 \
		xvfb \
	&& rm -rf /var/lib/apt/lists/*

# Install ODA File Converter (Linux) for DWG -> DXF conversion
COPY ODA/ODAFileConverter_QT6_lnxX64_8.3dll_27.1.deb /tmp/oda.deb
RUN set -eux; \
		apt-get update -qq; \
		apt-get install -y -qq /tmp/oda.deb; \
		rm -f /tmp/oda.deb; \
		ODA_BIN="$(command -v ODAFileConverter)"; \
		mkdir -p /opt/oda; \
		ln -sf "$ODA_BIN" /opt/oda/ODAFileConverter; \
		rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

COPY app /app/app

ENV PYTHONUNBUFFERED=1
ENV ODA_PATH=/opt/oda/ODAFileConverter

EXPOSE 8000
CMD ["python", "-m", "app.server"]