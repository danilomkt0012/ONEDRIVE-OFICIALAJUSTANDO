#!/usr/bin/env bash
set -uo pipefail

# Replit sets PIP_USER=1 globally which conflicts with --target. Disable it for this script
# and force pip to allow installs into the externally-managed system Python.
export PIP_USER=0
export PIP_BREAK_SYSTEM_PACKAGES=1

PIP_TARGET_DIR="${PIP_TARGET_DIR:-$HOME/workspace/.pythonlibs/lib/python3.11/site-packages}"
mkdir -p "$PIP_TARGET_DIR"
export PYTHONPATH="$PIP_TARGET_DIR:${PYTHONPATH:-}"
PIP_INSTALL=(python3 -m pip install --quiet --target "$PIP_TARGET_DIR" --upgrade --no-deps)

if python3 -c "import soundfile" 2>/dev/null; then
    echo "[install_tts] soundfile already installed — skipping."
else
    echo "[install_tts] Installing soundfile…"
    "${PIP_INSTALL[@]}" "soundfile>=0.13.0" cffi pycparser
fi

if python3 -c "import TTS" 2>/dev/null; then
    echo "[install_tts] TTS already installed — skipping."
else
    echo "[install_tts] Installing TTS (Coqui)…"
    python3 -m pip install --quiet --target "$PIP_TARGET_DIR" --upgrade "TTS>=0.22.0"
fi

INSTALLED_TORCH=$(python3 -c "import torch; print(torch.__version__.split('+')[0])" 2>/dev/null || echo "")
if [ -n "$INSTALLED_TORCH" ]; then
    echo "[install_tts] torch==$INSTALLED_TORCH already installed — keeping existing version."
else
    echo "[install_tts] torch not found. Installing CPU build…"
    python3 -m pip install --quiet --target "$PIP_TARGET_DIR" --upgrade \
        --index-url "https://download.pytorch.org/whl/cpu" \
        torch torchaudio
fi

INSTALLED_TORCHAUDIO=$(python3 -c "import torchaudio; print(torchaudio.__version__.split('+')[0])" 2>/dev/null || echo "")
if [ -n "$INSTALLED_TORCHAUDIO" ]; then
    echo "[install_tts] torchaudio==$INSTALLED_TORCHAUDIO already installed — keeping existing version."
else
    echo "[install_tts] torchaudio not found. Installing CPU build…"
    python3 -m pip install --quiet --target "$PIP_TARGET_DIR" --upgrade \
        --index-url "https://download.pytorch.org/whl/cpu" \
        torchaudio
fi

echo "[install_tts] Skipping torchcodec (not compatible with this environment)."
echo "[install_tts] Using soundfile backend for torchaudio instead."

TRANSFORMERS_VER=$(python3 -c "import transformers; print(transformers.__version__)" 2>/dev/null || echo "")
if [ -n "$TRANSFORMERS_VER" ]; then
    if python3 -c "v='$TRANSFORMERS_VER'.split('.');exit(0 if int(v[0])==4 and 41<=int(v[1])<50 else 1)" 2>/dev/null; then
        echo "[install_tts] transformers==$TRANSFORMERS_VER already installed (compatible) — skipping."
    else
        echo "[install_tts] Incompatible transformers==$TRANSFORMERS_VER detected. Replacing with compatible version…"
        python3 -m pip install --quiet "transformers>=4.41.0,<4.50.0"
    fi
else
    echo "[install_tts] Installing transformers…"
    python3 -m pip install --quiet "transformers>=4.41.0,<4.50.0"
fi

if python3 -c "import psutil" 2>/dev/null; then
    echo "[install_tts] psutil already installed — skipping."
else
    echo "[install_tts] Installing psutil…"
    python3 -m pip install --quiet "psutil>=5.9.0"
fi

if python3 -c "import fastapi" 2>/dev/null; then
    echo "[install_tts] fastapi already installed — skipping."
else
    echo "[install_tts] Installing fastapi…"
    python3 -m pip install --quiet "fastapi>=0.104.0"
fi

if python3 -c "import uvicorn" 2>/dev/null; then
    echo "[install_tts] uvicorn already installed — skipping."
else
    echo "[install_tts] Installing uvicorn…"
    python3 -m pip install --quiet "uvicorn>=0.24.0"
fi

if python3 -c "import multipart" 2>/dev/null; then
    echo "[install_tts] python-multipart already installed — skipping."
else
    echo "[install_tts] Installing python-multipart…"
    python3 -m pip install --quiet "python-multipart>=0.0.6"
fi

echo "[install_tts] Verifying critical dependencies…"
if python3 -c "import soundfile; print('soundfile OK')"; then
    echo "[install_tts] soundfile backend verified."
else
    echo "[install_tts] ERROR: soundfile import failed — torchaudio will not work!" >&2
    exit 1
fi

FINAL_TORCH=$(python3 -c "import torch; print(torch.__version__)" 2>/dev/null || echo "MISSING")
FINAL_TORCHAUDIO=$(python3 -c "import torchaudio; print(torchaudio.__version__)" 2>/dev/null || echo "MISSING")
echo "[install_tts] Final versions: torch=$FINAL_TORCH torchaudio=$FINAL_TORCHAUDIO"

echo "[install_tts] All TTS dependencies are installed."
