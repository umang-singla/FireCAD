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
COPY api/ODA/ODAFileConverter_QT6_lnxX64_8.3dll_27.1.deb /tmp/oda.deb
RUN set -eux; \
		apt-get update -qq; \
		apt-get install -y -qq /tmp/oda.deb; \
		rm -f /tmp/oda.deb; \
		ODA_BIN="$(command -v ODAFileConverter)"; \
		mkdir -p /opt/oda; \
		ln -sf "$ODA_BIN" /opt/oda/ODAFileConverter; \
		rm -rf /var/lib/apt/lists/*

# Bundle QCAD binaries for DWG preview rendering in cloud environments
COPY qcad-3.32.6-trial-linux-x86_64 /opt/qcad
RUN set -eux; \
		chmod +x /opt/qcad/dwg2bmp /opt/qcad/qcad-bin /opt/qcad/qcad; \
		cp /opt/qcad/*.so* /usr/lib/; \
		ldconfig; \
		test -f /opt/qcad/libqcadecmaapi.so; \
		if /opt/qcad/qcad -platform offscreen -version >/tmp/qcad_version.txt 2>/tmp/qcad_version_err.txt; then \
			cat /tmp/qcad_version.txt; \
		else \
			echo "QCAD version sanity check failed at build time (non-fatal)."; \
			tail -n 80 /tmp/qcad_version_err.txt || true; \
		fi

WORKDIR /app
COPY api/requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

COPY api/app /app/app

ENV PYTHONUNBUFFERED=1
ENV ODA_PATH=/opt/oda/ODAFileConverter
ENV QCAD_DWG2BMP=/opt/qcad/dwg2bmp
ENV USE_QCAD_DWG2BMP=1
ENV LD_LIBRARY_PATH=/opt/qcad

EXPOSE 8000
CMD ["python", "-m", "app.server"]