#!/usr/bin/env bash
# Python packages for engine/tests on a CI machine without a GPU (AVE_ALLOW_CPU=1).
# The engine can pin its own list in engine/requirements-ci.txt; otherwise the October 5 stack
# is installed with the CPU build of PyTorch.
set -euo pipefail
python -m pip install --upgrade pip
if [ -f engine/requirements-ci.txt ]; then
  python -m pip install -r engine/requirements-ci.txt
else
  python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
  python -m pip install numpy scipy pillow opencv-python-headless
fi
python -m pip install pytest
