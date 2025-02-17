#!/bin/bash
# Install Google Cloud SDK
echo "Installing Google Cloud SDK..."
curl -sSL https://sdk.cloud.google.com | bash
exec -l $SHELL
gcloud auth activate-service-account --key-file=your-service-account-key.json
