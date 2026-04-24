#!/usr/bin/env bash
set -euo pipefail

PYTORCH_INDEX="https://download.pytorch.org/whl/cpu"
EXPECTED_TORCH="2.6.0"
EXPECTED_TORCHAUDIO="2.6.0"

if python3 -c "import soundfile" 2>/dev/null; then
    echo "[install_tts] soundfile already installed — skipping."
else
    echo "[install_tts] Installing soundfile…"
    python3 -m pip install --quiet "soundfile>=0.13.0"
fi

if python3 -c "import TTS" 2>/dev/null; then
    echo "[install_tts] TTS already installed — skipping."
else
    echo "[install_tts] Installing TTS (Coqui)…"
    python3 -m pip install --quiet "TTS>=0.22.0"
fi

INSTALLED_TORCH=$(python3 -c "import torch; print(torch.__version__.split('+')[0])" 2>/dev/null || echo "")
if [ "$INSTALLED_TORCH" = "$EXPECTED_TORCH" ]; then
    echo "[install_tts] torch==$EXPECTED_TORCH already installed — skipping."
else
    if [ -n "$INSTALLED_TORCH" ]; then
        echo "[install_tts] Wrong torch version detected: $INSTALLED_TORCH (expected $EXPECTED_TORCH). Replacing…"
    else
        echo "[install_tts] torch not found. Installing…"
    fi
    python3 -m pip install --quiet --force-reinstall \
        --index-url "$PYTORCH_INDEX" \
        "torch==$EXPECTED_TORCH"
fi

INSTALLED_TORCHAUDIO=$(python3 -c "import torchaudio; print(torchaudio.__version__.split('+')[0])" 2>/dev/null || echo "")
if [ "$INSTALLED_TORCHAUDIO" = "$EXPECTED_TORCHAUDIO" ]; then
    echo "[install_tts] torchaudio==$EXPECTED_TORCHAUDIO already installed — skipping."
else
    if [ -n "$INSTALLED_TORCHAUDIO" ]; then
        echo "[install_tts] Wrong torchaudio version detected: $INSTALLED_TORCHAUDIO (expected $EXPECTED_TORCHAUDIO). Replacing…"
    else
        echo "[install_tts] torchaudio not found. Installing…"
    fi
    python3 -m pip install --quiet --force-reinstall \
        --index-url "$PYTORCH_INDEX" \
        "torchaudio==$EXPECTED_TORCHAUDIO"
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
