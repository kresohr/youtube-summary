#!/bin/bash
# init-ssl.sh — Obtain initial Let's Encrypt certificate
# Run this ONCE on your VPS before starting the production stack.
#
# Usage: ./init-ssl.sh yourdomain.com your@email.com

set -e

DOMAIN="${1:?Usage: $0 <domain> <email>}"
EMAIL="${2:?Usage: $0 <domain> <email>}"
CERT_PATH="${SSL_CERT_PATH:-./nginx/certs}"

echo "==> Obtaining SSL certificate for ${DOMAIN}..."

# 1. Start a temporary nginx that serves only the ACME challenge on port 80
docker run -d --name certbot-init-nginx \
  -p 80:80 \
  -v "$(pwd)/nginx/init-nginx.conf:/etc/nginx/nginx.conf:ro" \
  -v certbot_www:/var/www/certbot \
  nginx:1.25-alpine

# 2. Run certbot to get the certificate
docker run --rm \
  -v "${CERT_PATH}:/etc/letsencrypt" \
  -v certbot_www:/var/www/certbot \
  certbot/certbot:latest certonly \
    --webroot -w /var/www/certbot \
    -d "${DOMAIN}" \
    --email "${EMAIL}" \
    --agree-tos \
    --no-eff-email \
    --force-renewal

# 3. Clean up temporary nginx
docker stop certbot-init-nginx && docker rm certbot-init-nginx

echo ""
echo "==> Certificate obtained successfully!"
echo "    Cert path: ${CERT_PATH}/live/${DOMAIN}/"
echo ""
echo "Now start the full stack:"
echo "  docker compose --profile production up -d"
