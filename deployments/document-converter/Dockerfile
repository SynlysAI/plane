FROM gotenberg/gotenberg:8.38.1-libreoffice

USER root
RUN apt-get update -qq \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
       curl fonts-noto-cjk fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
USER gotenberg
