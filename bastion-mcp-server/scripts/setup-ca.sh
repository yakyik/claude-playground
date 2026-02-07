#!/usr/bin/env bash
# Generate a self-signed CA, server cert, and client cert for mTLS testing.
# Output: certs/ directory with all PEM files.
#
# Usage:
#   ./scripts/setup-ca.sh [domain]
#   default domain: localhost

set -euo pipefail

DOMAIN="${1:-localhost}"
CERTS_DIR="certs"
DAYS=365

echo "==> Generating mTLS certificates for ${DOMAIN}"
mkdir -p "${CERTS_DIR}"

# 1. CA
echo "--- Generating CA ---"
openssl genrsa -out "${CERTS_DIR}/ca-key.pem" 4096 2>/dev/null
openssl req -new -x509 -days ${DAYS} -key "${CERTS_DIR}/ca-key.pem" \
  -out "${CERTS_DIR}/ca-cert.pem" \
  -subj "/CN=Bastion CA/O=claude-playground"

# 2. Server cert
echo "--- Generating server cert ---"
openssl genrsa -out "${CERTS_DIR}/server-key.pem" 2048 2>/dev/null
openssl req -new -key "${CERTS_DIR}/server-key.pem" \
  -out "${CERTS_DIR}/server.csr" \
  -subj "/CN=${DOMAIN}/O=claude-playground"

openssl x509 -req -days ${DAYS} \
  -in "${CERTS_DIR}/server.csr" \
  -CA "${CERTS_DIR}/ca-cert.pem" \
  -CAkey "${CERTS_DIR}/ca-key.pem" \
  -CAcreateserial \
  -out "${CERTS_DIR}/server-cert.pem" \
  -extfile <(printf "subjectAltName=DNS:${DOMAIN},DNS:localhost,IP:127.0.0.1") 2>/dev/null

# 3. Client cert
echo "--- Generating client cert ---"
openssl genrsa -out "${CERTS_DIR}/client-key.pem" 2048 2>/dev/null
openssl req -new -key "${CERTS_DIR}/client-key.pem" \
  -out "${CERTS_DIR}/client.csr" \
  -subj "/CN=bastion-client/O=claude-playground"

openssl x509 -req -days ${DAYS} \
  -in "${CERTS_DIR}/client.csr" \
  -CA "${CERTS_DIR}/ca-cert.pem" \
  -CAkey "${CERTS_DIR}/ca-key.pem" \
  -CAcreateserial \
  -out "${CERTS_DIR}/client-cert.pem" 2>/dev/null

# Cleanup CSR files
rm -f "${CERTS_DIR}"/*.csr "${CERTS_DIR}"/*.srl

echo ""
echo "==> Certificates generated in ${CERTS_DIR}/"
ls -la "${CERTS_DIR}/"
echo ""
echo "CA cert:     ${CERTS_DIR}/ca-cert.pem"
echo "Server cert: ${CERTS_DIR}/server-cert.pem"
echo "Server key:  ${CERTS_DIR}/server-key.pem"
echo "Client cert: ${CERTS_DIR}/client-cert.pem"
echo "Client key:  ${CERTS_DIR}/client-key.pem"
