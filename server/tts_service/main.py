"""
XTTS v2 TTS Microservice — FastAPI server on port 5500.

Hardening features:
  - Concurrency limiter: max 2 simultaneous generations (semaphore)
  - Queue depth guard: rejects requests when > 5 are waiting
  - Per-request timeout: 120 s (asyncio.wait_for, tuned for CPU-only)
  - /health returns model status, memory, uptime and queue depth
  - Structured log lines include timing, queue depth and memory
  - Temp files always cleaned up in finally blocks
  - torch.load compat patch scoped to model-load only (weights_only=False)
  - Full traceback logging on all exceptions
  - Request payload logging on entry, response status/size on success
"""
from contextlib import contextmanager
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
import asyncio
import logging
import os
import psutil
import sys
import tempfile
import time
import traceback
import torch
import torchaudio
import soundfile as sf
import types


def _soundfile_load(
    uri,
    frame_offset=0,
    num_frames=-1,
    normalize=True,
    channels_first=True,
    format=None,
    buffer_size=4096,
    backend=None,
):
    data, sample_rate = sf.read(uri, start=frame_offset,
                                 stop=frame_offset + num_frames if num_frames > 0 else None,
                                 dtype="float32", always_2d=True)
    tensor = torch.from_numpy(data.T if channels_first else data)
    return tensor, sample_rate


def _soundfile_save(
    uri,
    src,
    sample_rate,
    channels_first=True,
    format=None,
    encoding=None,
    bits_per_sample=None,
    buffer_size=4096,
    backend=None,
    compression=None,
):
    if isinstance(src, torch.Tensor):
        src = src.detach().cpu().numpy()
    if channels_first and src.ndim == 2:
        src = src.T
    path = str(uri)
    subtype = None
    if bits_per_sample == 16:
        subtype = "PCM_16"
    elif bits_per_sample == 24:
        subtype = "PCM_24"
    elif bits_per_sample == 32:
        subtype = "PCM_32"
    fmt = format
    if fmt is None:
        ext = os.path.splitext(path)[1].lstrip(".").upper()
        fmt_map = {"WAV": "WAV", "FLAC": "FLAC", "OGG": "OGG", "MP3": "MP3"}
        fmt = fmt_map.get(ext, "WAV")
    sf.write(path, src, sample_rate, subtype=subtype, format=fmt)


if 'torchcodec' not in sys.modules:
    _fake_torchcodec = types.ModuleType('torchcodec')
    _fake_torchcodec.__version__ = '0.0.0'
    sys.modules['torchcodec'] = _fake_torchcodec

_original_torchaudio_load = torchaudio.load
_original_torchaudio_save = getattr(torchaudio, 'save', None)

if hasattr(_original_torchaudio_load, '__globals__'):
    if 'load_with_torchcodec' in _original_torchaudio_load.__globals__:
        _original_torchaudio_load.__globals__['load_with_torchcodec'] = _soundfile_load
    if 'save_with_torchcodec' in _original_torchaudio_load.__globals__:
        _original_torchaudio_load.__globals__['save_with_torchcodec'] = _soundfile_save
if _original_torchaudio_save and hasattr(_original_torchaudio_save, '__globals__'):
    if 'load_with_torchcodec' in _original_torchaudio_save.__globals__:
        _original_torchaudio_save.__globals__['load_with_torchcodec'] = _soundfile_load
    if 'save_with_torchcodec' in _original_torchaudio_save.__globals__:
        _original_torchaudio_save.__globals__['save_with_torchcodec'] = _soundfile_save

torchaudio.load = _soundfile_load
torchaudio.save = _soundfile_save

torchaudio.load_with_torchcodec = _soundfile_load
torchaudio.save_with_torchcodec = _soundfile_save

vars(torchaudio)['load_with_torchcodec'] = _soundfile_load
vars(torchaudio)['save_with_torchcodec'] = _soundfile_save
sys.modules['torchaudio'].__dict__['load_with_torchcodec'] = _soundfile_load
sys.modules['torchaudio'].__dict__['save_with_torchcodec'] = _soundfile_save

try:
    import torchaudio._torchcodec as _real_torchcodec
    _real_torchcodec.load_with_torchcodec = _soundfile_load
    if hasattr(_real_torchcodec, 'save_with_torchcodec'):
        _real_torchcodec.save_with_torchcodec = _soundfile_save
    sys.modules['torchaudio._torchcodec'].__dict__['load_with_torchcodec'] = _soundfile_load
    sys.modules['torchaudio._torchcodec'].__dict__['save_with_torchcodec'] = _soundfile_save
except (ImportError, ModuleNotFoundError):
    _torchcodec_mod = types.ModuleType("torchaudio._torchcodec")
    _torchcodec_mod.load_with_torchcodec = _soundfile_load
    _torchcodec_mod.save_with_torchcodec = _soundfile_save
    sys.modules["torchaudio._torchcodec"] = _torchcodec_mod
    torchaudio._torchcodec = _torchcodec_mod

for _submod_name in list(sys.modules.keys()):
    if _submod_name.startswith("torchaudio"):
        _submod = sys.modules[_submod_name]
        if _submod is not None:
            for _attr_name in dir(_submod):
                try:
                    _attr = getattr(_submod, _attr_name, None)
                except Exception:
                    continue
                if callable(_attr) and hasattr(_attr, '__globals__'):
                    _g = _attr.__globals__
                    if 'load_with_torchcodec' in _g:
                        try:
                            _g['load_with_torchcodec'] = _soundfile_load
                        except (TypeError, AttributeError):
                            pass
                    if 'save_with_torchcodec' in _g:
                        try:
                            _g['save_with_torchcodec'] = _soundfile_save
                        except (TypeError, AttributeError):
                            pass
            if hasattr(_submod, 'load') and _submod_name != 'torchaudio':
                try:
                    _submod.load = _soundfile_load
                except (AttributeError, TypeError):
                    pass
            if hasattr(_submod, 'load_with_torchcodec'):
                try:
                    _submod.load_with_torchcodec = _soundfile_load
                except (AttributeError, TypeError):
                    pass
            if hasattr(_submod, 'save_with_torchcodec'):
                try:
                    _submod.save_with_torchcodec = _soundfile_save
                except (AttributeError, TypeError):
                    pass

try:
    if hasattr(torchaudio, "set_audio_backend"):
        torchaudio.set_audio_backend("soundfile")
except Exception:
    pass

logging.basicConfig(
    level=logging.INFO,
    stream=sys.stdout,
    format="%(asctime)s %(levelname)s [TTS] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
logger = logging.getLogger(__name__)
logger.info("Audio I/O backend: soundfile (torchaudio.load/save monkey-patched to bypass torchcodec)")
logger.info("torchaudio version: %s | torch version: %s", torchaudio.__version__, torch.__version__)

import io
import numpy as np

def _create_test_wav_bytes():
    sample_rate = 16000
    duration = 0.1
    n_samples = int(sample_rate * duration)
    samples = np.zeros(n_samples, dtype=np.float32)
    buf = io.BytesIO()
    sf.write(buf, samples, sample_rate, format='WAV', subtype='FLOAT')
    buf.seek(0)
    return buf

def _verify_torchaudio_patch():
    try:
        test_buf = _create_test_wav_bytes()
        import tempfile as _tmpmod
        fd, tmp_wav = _tmpmod.mkstemp(suffix=".wav")
        os.close(fd)
        try:
            with open(tmp_wav, 'wb') as f:
                f.write(test_buf.read())
            waveform, sr = torchaudio.load(tmp_wav)
            if not isinstance(waveform, torch.Tensor):
                logger.error(
                    "[PATCH_CHECK] torchaudio.load returned %s instead of torch.Tensor — patch may not be active!",
                    type(waveform).__name__,
                )
                return False
            logger.info(
                "[PATCH_CHECK] torchaudio.load patch verified OK (shape=%s, sr=%d)",
                list(waveform.shape), sr,
            )
            return True
        finally:
            try:
                os.unlink(tmp_wav)
            except OSError:
                pass
    except ImportError as exc:
        if 'torchcodec' in str(exc).lower() or 'TorchCodec' in str(exc):
            logger.error(
                "[PATCH_CHECK] FAILED — torchaudio.load still requires torchcodec: %s", exc
            )
            return False
        raise
    except Exception as exc:
        logger.error("[PATCH_CHECK] Unexpected error verifying patch: %s", exc)
        return False

_patch_ok = _verify_torchaudio_patch()
if not _patch_ok:
    logger.critical("[PATCH_CHECK] torchaudio monkey-patch DID NOT take effect — refusing to start with broken audio I/O!")
    sys.exit(1)

PROCESS = psutil.Process()
START_TIME = time.time()

MAX_CONCURRENT = 2
MAX_QUEUE_DEPTH = 5
GENERATION_TIMEOUT_S = 120

_semaphore = asyncio.Semaphore(MAX_CONCURRENT)
_queue_depth = 0


@contextmanager
def _legacy_torch_load():
    """
    Temporarily allow torch.load to deserialise arbitrary globals.
    Required for TTS 0.22.0 model checkpoints which pre-date PyTorch 2.6's
    safe-loading defaults (weights_only changed from False → True in 2.6).
    Scoped to model load only — torch.load is restored immediately after.
    """
    _original = torch.load

    def _patched(f, *args, **kwargs):
        kwargs.setdefault("weights_only", False)
        return _original(f, *args, **kwargs)

    torch.load = _patched
    try:
        yield
    finally:
        torch.load = _original


app = FastAPI(title="XTTS v2 TTS Service", version="2.0.0")

tts_model = None
_model_loading = False

_model_load_count = 0

def load_model():
    global tts_model, _model_load_count, _model_loading
    if tts_model is not None:
        return tts_model
    _model_load_count += 1
    if _model_load_count > 1:
        logger.warning("Model load called %d times — expected single-load pattern", _model_load_count)
    _model_loading = True
    try:
        from TTS.api import TTS
        logger.info("Loading XTTS v2 model (first run may download ~2 GB)…")
        with _legacy_torch_load():
            tts_model = TTS("tts_models/multilingual/multi-dataset/xtts_v2")
        logger.info("MODEL LOADED SUCCESSFULLY")
        _model_loading = False
        return tts_model
    except Exception as exc:
        _model_loading = False
        logger.critical("CRITICAL ERROR: model failed to load — %s", exc)
        traceback.print_exc()
        raise RuntimeError(f"Model load failed: {exc}") from exc


def _mem_mb() -> float:
    try:
        return round(PROCESS.memory_info().rss / 1024 / 1024, 1)
    except Exception:
        return -1.0


@app.on_event("startup")
async def _startup():
    logger.info("TTS Service starting — loading model in background…")
    loop = asyncio.get_event_loop()

    async def _log_memory_loop():
        while True:
            await asyncio.sleep(60)
            logger.info(
                "memory_rss_mb=%.1f queue_depth=%d active=%d uptime_s=%.0f",
                _mem_mb(),
                _queue_depth,
                MAX_CONCURRENT - _semaphore._value,
                time.time() - START_TIME,
            )

    asyncio.ensure_future(_log_memory_loop())

    async def _load_model_background():
        try:
            await loop.run_in_executor(None, load_model)
            logger.info("MODEL LOADED SUCCESSFULLY — ready on startup. memory_rss_mb=%.1f", _mem_mb())
            asyncio.ensure_future(_run_self_test())
        except Exception as exc:
            logger.critical(
                "CRITICAL ERROR: model failed to load on startup (will retry on first request): %s", exc
            )
            traceback.print_exc()

    asyncio.ensure_future(_load_model_background())


def _create_speech_like_wav(path: str) -> None:
    import random
    import struct
    import wave
    import math

    sample_rate = 22050
    duration = 3
    num_samples = sample_rate * duration
    random.seed(42)

    samples = []
    formants = [250.0, 700.0, 2500.0, 3500.0]
    for i in range(num_samples):
        t = i / sample_rate
        envelope = 0.6 + 0.4 * math.sin(2.0 * math.pi * 3.0 * t)
        pitch = 120.0 + 30.0 * math.sin(2.0 * math.pi * 0.5 * t)
        val = 0.0
        for f in formants:
            val += math.sin(2.0 * math.pi * f * t + pitch * t * 0.01)
        val *= envelope
        noise = (random.random() * 2.0 - 1.0) * 0.3
        val = (val / len(formants) + noise) * 0.7
        samples.append(int(max(-32767, min(32767, val * 16000))))

    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(struct.pack(f"<{num_samples}h", *samples))


async def _run_self_test():
    import aiohttp

    await asyncio.sleep(3)
    port = int(os.environ.get("TTS_PORT", 5500))
    url = f"http://localhost:{port}/generate"

    ref_path = f"/tmp/tts_self_test_ref_py_{os.getpid()}_{int(time.time()*1000)}.wav"
    try:
        _create_speech_like_wav(ref_path)
        logger.info("[SELF_TEST] Created speech-like reference WAV at %s (3s, 22050Hz)", ref_path)
    except Exception as exc:
        logger.error("[SELF_TEST] Failed to create reference WAV: %s", exc)
        traceback.print_exc()
        logger.info("[SELF_TEST_SUMMARY] Diagnostic self-test FAILED (could not create reference). "
                     "The TTS service is still available for real requests with user-provided voice references.")
        return

    payload = {
        "text": "Teste.",
        "reference_wav_path": ref_path,
        "language": "pt",
        "speed": 1.0,
    }
    logger.info("[SELF_TEST] Starting diagnostic self-test POST to %s", url)
    t0 = time.time()
    passed = False
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload, timeout=aiohttp.ClientTimeout(total=90)) as resp:
                body = await resp.read()
                elapsed = time.time() - t0
                if 200 <= resp.status < 300:
                    if len(body) > 0:
                        logger.info(
                            "[SELF_TEST] Passed. status=%d output_bytes=%d elapsed_s=%.2f",
                            resp.status,
                            len(body),
                            elapsed,
                        )
                        passed = True
                    else:
                        logger.warning(
                            "[SELF_TEST] Failed. status=%d but output is empty. elapsed_s=%.2f",
                            resp.status,
                            elapsed,
                        )
                else:
                    detail = body.decode("utf-8", errors="replace")[:300]
                    logger.warning(
                        "[SELF_TEST] Failed. status=%d elapsed_s=%.2f detail=%s",
                        resp.status,
                        elapsed,
                        detail,
                    )
    except Exception as exc:
        elapsed = time.time() - t0
        logger.error("[SELF_TEST] Error. elapsed_s=%.2f error=%s", elapsed, exc)
        traceback.print_exc()
    finally:
        try:
            if os.path.exists(ref_path):
                os.unlink(ref_path)
        except OSError:
            pass

    if passed:
        logger.info("[SELF_TEST_SUMMARY] Diagnostic self-test PASSED. TTS service is fully operational.")
    else:
        logger.info("[SELF_TEST_SUMMARY] Diagnostic self-test FAILED. This is a startup diagnostic only — "
                     "the TTS service is still available for real requests with user-provided voice references.")


@app.get("/health")
async def health():
    model_loaded = tts_model is not None
    model_loading = _model_loading
    if model_loaded:
        status = "ok"
    elif model_loading:
        status = "loading"
    else:
        status = "degraded"
    result = {
        "status": status,
        "model_loaded": model_loaded,
        "model_loading": model_loading,
        "memory_rss_mb": _mem_mb(),
        "uptime_s": round(time.time() - START_TIME, 1),
        "max_concurrent": MAX_CONCURRENT,
        "max_queue_depth": MAX_QUEUE_DEPTH,
        "generation_timeout_s": GENERATION_TIMEOUT_S,
        "queue": {
            "active": MAX_CONCURRENT - _semaphore._value,
            "pending": _queue_depth,
        },
    }
    if not model_loaded and not model_loading:
        result["error"] = "Model not loaded — TTS generation will fail until model is loaded"
    return result


class GenerateRequest(BaseModel):
    text: str
    reference_wav_path: str
    language: str = "pt"
    speed: float = 1.0


@app.post("/generate")
async def generate_audio(req: GenerateRequest):
    global _queue_depth

    logger.info(
        "Request received. text_len=%d ref=%s language=%s speed=%.2f",
        len(req.text),
        req.reference_wav_path[-40:],
        req.language,
        req.speed,
    )

    if not req.text or not req.text.strip():
        logger.warning("Rejected: empty text")
        raise HTTPException(status_code=400, detail="text is required")

    if not os.path.exists(req.reference_wav_path):
        logger.warning(
            "Rejected: reference audio not found. path=%s", req.reference_wav_path
        )
        raise HTTPException(
            status_code=400,
            detail=f"Reference audio not found: {req.reference_wav_path}",
        )

    if _queue_depth >= MAX_QUEUE_DEPTH:
        logger.warning(
            "Queue full — rejecting request. queue_depth=%d", _queue_depth
        )
        raise HTTPException(
            status_code=503,
            detail=f"TTS queue full ({_queue_depth} requests waiting). Try again shortly.",
        )

    _queue_depth += 1
    t_queued = time.time()
    logger.info(
        "Request queued. text_len=%d queue_depth=%d memory_rss_mb=%.1f",
        len(req.text),
        _queue_depth,
        _mem_mb(),
    )

    try:
        model = load_model()
    except RuntimeError as exc:
        _queue_depth -= 1
        logger.error("Model load failed during request: %s", exc)
        traceback.print_exc()
        raise HTTPException(status_code=503, detail=str(exc))

    tmp_path = None
    try:
        async with _semaphore:
            _queue_depth -= 1
            t_start = time.time()

            tmp_fd, tmp_path = tempfile.mkstemp(suffix=".wav")
            os.close(tmp_fd)

            speed = max(0.5, min(2.0, req.speed))

            loop = asyncio.get_event_loop()

            def _generate():
                try:
                    model.tts_to_file(
                        text=req.text,
                        speaker_wav=req.reference_wav_path,
                        language=req.language,
                        file_path=tmp_path,
                        speed=speed,
                    )
                except Exception:
                    logger.error("AUDIO LOAD ERROR: %s", traceback.format_exc())
                    raise

            try:
                await asyncio.wait_for(
                    loop.run_in_executor(None, _generate),
                    timeout=GENERATION_TIMEOUT_S,
                )
            except asyncio.TimeoutError:
                elapsed = time.time() - t_start
                logger.error(
                    "Generation timeout after %.1fs (limit=%ds). text_len=%d elapsed_s=%.2f",
                    elapsed,
                    GENERATION_TIMEOUT_S,
                    len(req.text),
                    elapsed,
                )
                raise HTTPException(
                    status_code=504,
                    detail=f"TTS generation timed out after {GENERATION_TIMEOUT_S}s (text_len={len(req.text)}).",
                )

            elapsed = time.time() - t_start
            wait_s = t_start - t_queued

            if not os.path.exists(tmp_path):
                logger.error(
                    "Output WAV file missing after generation. tmp_path=%s text_len=%d",
                    tmp_path,
                    len(req.text),
                )
                raise HTTPException(
                    status_code=500,
                    detail="TTS generation produced no output file.",
                )

            file_size = os.path.getsize(tmp_path)
            if file_size == 0:
                logger.error(
                    "Output WAV file is empty. tmp_path=%s text_len=%d",
                    tmp_path,
                    len(req.text),
                )
                raise HTTPException(
                    status_code=500,
                    detail="TTS generation produced empty output file.",
                )

            with open(tmp_path, "rb") as fh:
                audio_bytes = fh.read()

            logger.info(
                "Generation complete. text_len=%d wait_s=%.2f gen_s=%.2f "
                "output_bytes=%d memory_rss_mb=%.1f",
                len(req.text),
                wait_s,
                elapsed,
                len(audio_bytes),
                _mem_mb(),
            )

            return Response(
                content=audio_bytes,
                media_type="audio/wav",
                headers={"Content-Disposition": "attachment; filename=generated.wav"},
            )

    except HTTPException:
        raise
    except Exception as exc:
        logger.error("TTS generation failed: %s", exc)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"TTS generation failed: {exc}")
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except Exception as cleanup_err:
                logger.warning("Failed to clean up temp file %s: %s", tmp_path, cleanup_err)


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("TTS_PORT", 5500))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
