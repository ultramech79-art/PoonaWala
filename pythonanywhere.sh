#!/bin/bash

# PythonAnywhere Deploy Script
# Prerequisites: pip install pythonanywhere

set -e

echo "🚀 Deploying to PythonAnywhere..."

# Install PythonAnywhere CLI
pip install pythonanywhere

# Get username from user
read -p "Enter your PythonAnywhere username: " PA_USERNAME
read -p "Enter your PythonAnywhere API token (get from https://www.pythonanywhere.com/user/$PA_USERNAME/account/#api_token): " PA_TOKEN

# Create virtual environment
echo "Setting up environment..."
pa_create_webapp_with_virtualenv.py $PA_USERNAME python38

# Get the webapp directory
DOMAIN="${PA_USERNAME}.pythonanywhere.com"
WEBAPP_DIR="/home/${PA_USERNAME}/mysite"

echo "Deploying code..."
# Clone or pull the repo
ssh ${PA_USERNAME}@ssh.pythonanywhere.com "cd $WEBAPP_DIR && rm -rf * && git clone https://github.com/Ultramech/PoonaWala . || git pull"

# Configure WSGI
ssh ${PA_USERNAME}@ssh.pythonanywhere.com "cat > $WEBAPP_DIR/mysite_wsgi.py << 'WSGI_EOF'
import sys
sys.path.insert(0, '/home/${PA_USERNAME}/mysite/apps/api')
from app.main import app as application
WSGI_EOF"

# Reload the app
curl -X POST "https://www.pythonanywhere.com/api/v0/user/${PA_USERNAME}/webapps/${DOMAIN}/reload/" \
  -H "Authorization: Token ${PA_TOKEN}"

echo "✅ Deployed to https://${DOMAIN}"
echo "Now add environment variables in PythonAnywhere dashboard"
