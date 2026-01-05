# optimised server file

# server.py - Optimized Video Caption API
import os
import torch
import tempfile
import requests
from fastapi import FastAPI, HTTPException, BackgroundTasks, Body, Query
from pydantic import BaseModel, Field
from contextlib import asynccontextmanager
from transformers import BitsAndBytesConfig
from qwen_vl_utils import process_vision_info
import boto3
from botocore.exceptions import ClientError
import logging
from typing import List, Optional, Literal
from functools import lru_cache
import httpx
from openai import OpenAI
import anthropic
from groq import Groq
from dotenv import load_dotenv

load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# =============================================================================
# CONFIGURATION
# =============================================================================

# Model configuration
MODEL_ID = os.getenv("MODEL_ID", "Qwen/Qwen3-VL-8B-Instruct")
QUANTIZATION = os.getenv("QUANTIZATION", "None")  # "None", "8-bit", "4-bit"
ATTENTION_IMPL = os.getenv("ATTENTION_IMPL", "flash_attention_2")
MAX_TOKENS = int(os.getenv("MAX_TOKENS", "1024"))
RESOLUTION_MODE = os.getenv("RESOLUTION_MODE", "auto")

# Prompt configuration
PROMPT_FILE_PATH = os.getenv("PROMPT_FILE_PATH", "./prompt.txt")
DEFAULT_PROMPT = "Describe this video."

# API configuration
CAPTION_RESULT_ENDPOINT = os.getenv("RESPONSE_WEBHOOK_URL")
RESULT_API_TIMEOUT = int(os.getenv("RESULT_API_TIMEOUT", "30"))
RESULT_API_KEY = os.getenv("RESULT_API_KEY", "")

# AWS configuration
AWS_ACCESS_KEY_ID = os.getenv("AWS_ACCESS_KEY_ID")
AWS_SECRET_ACCESS_KEY = os.getenv("AWS_SECRET_ACCESS_KEY")
AWS_REGION = os.getenv("AWS_REGION", "us-east-1")

# LLM configuration
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "groq").lower()
CHAT_MAX_TOKENS = int(os.getenv("CHAT_MAX_TOKENS", "2000"))
CHAT_TEMPERATURE = float(os.getenv("CHAT_TEMPERATURE", "0.7"))
CHAT_SYSTEM_PROMPT = os.getenv("CHAT_SYSTEM_PROMPT", """You are a helpful AI assistant that helps users refine and modify video processing steps or captions. 
Users may have generated steps or captions from videos, and they want to chat with you to make changes, improvements, or ask questions.
Be concise, helpful, and focus on understanding what changes the user wants to make.""")

# Audio configuration
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "whisper-large-v3")
USE_AUDIO_GUARDRAIL = os.getenv("USE_AUDIO_GUARDRAIL", "true").lower() == "true"
AUDIO_SOURCE_MODE = os.getenv("AUDIO_SOURCE_MODE", "extract")  # "separate", "extract", "both"
AUDIO_EXTRACT_FORMAT = os.getenv("AUDIO_EXTRACT_FORMAT", "mp3")
AUDIO_EXTRACT_BITRATE = os.getenv("AUDIO_EXTRACT_BITRATE", "128k")

# File extensions (defined once)
VIDEO_EXTENSIONS = ('.mp4', '.mov', '.avi', '.webm', '.mkv', '.gif', '.flv')
AUDIO_EXTENSIONS = ('.mp3', '.m4a', '.wav', '.flac', '.ogg', '.opus', '.webm')

# LLM Provider configurations
LLM_CONFIGS = {
    "openai": {
        "api_key_env": "OPENAI_API_KEY",
        "model_env": "OPENAI_MODEL",
        "default_model": "gpt-4o-mini",
        "base_url": os.getenv("OPENAI_BASE_URL"),
    },
    "groq": {
        "api_key_env": "GROQ_API_KEY",
        "model_env": "GROQ_MODEL",
        "default_model": "llama-3.3-70b-versatile",
        "base_url": "https://api.groq.com/openai/v1",
    },
    "together": {
        "api_key_env": "TOGETHER_API_KEY",
        "model_env": "TOGETHER_MODEL",
        "default_model": "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo",
        "base_url": "https://api.together.xyz/v1",
    },
    "openrouter": {
        "api_key_env": "OPENROUTER_API_KEY",
        "model_env": "OPENROUTER_MODEL",
        "default_model": "anthropic/claude-3.5-sonnet",
        "base_url": "https://openrouter.ai/api/v1",
    },
    "anthropic": {
        "api_key_env": "ANTHROPIC_API_KEY",
        "model_env": "ANTHROPIC_MODEL",
        "default_model": "claude-3-5-sonnet-20241022",
    },
}

# =============================================================================
# GLOBAL STATE
# =============================================================================

model = None
processor = None
http_client: Optional[httpx.Client] = None

# =============================================================================
# HTTP CLIENT WITH CONNECTION POOLING
# =============================================================================

def get_http_client() -> httpx.Client:
    """Get or create HTTP client with connection pooling."""
    global http_client
    if http_client is None:
        http_client = httpx.Client(
            timeout=httpx.Timeout(300.0, connect=10.0),
            limits=httpx.Limits(max_keepalive_connections=10, max_connections=20),
        )
    return http_client


def get_webhook_headers() -> dict:
    """Build webhook headers."""
    headers = {"Content-Type": "application/json"}
    if RESULT_API_KEY:
        headers["Authorization"] = f"Bearer {RESULT_API_KEY}"
    return headers


# =============================================================================
# LLM CLIENT
# =============================================================================

class LLMClient:
    """Unified LLM client supporting multiple providers."""

    def __init__(self, provider: str = LLM_PROVIDER):
        self.provider = provider.lower()
        self.client = None
        self.model = None
        self._initialize()

    def _initialize(self):
        """Initialize the LLM client based on provider."""
        if self.provider == "anthropic":
            self._init_anthropic()
        else:
            self._init_openai_compatible()
        logger.info(f"LLM client initialized: {self.provider} ({self.model})")

    def _init_anthropic(self):
        config = LLM_CONFIGS["anthropic"]
        api_key = os.getenv(config["api_key_env"])
        if not api_key:
            raise ValueError(f"{config['api_key_env']} not set")
        self.client = anthropic.Anthropic(api_key=api_key)
        self.model = os.getenv(config["model_env"], config["default_model"])

    def _init_openai_compatible(self):
        config = LLM_CONFIGS.get(self.provider)
        if not config:
            raise ValueError(f"Unknown provider: {self.provider}")
        
        api_key = os.getenv(config["api_key_env"])
        if not api_key:
            raise ValueError(f"{config['api_key_env']} not set")
        
        self.client = OpenAI(api_key=api_key, base_url=config.get("base_url"))
        self.model = os.getenv(config["model_env"], config["default_model"])

    def chat(self, messages: List[dict], max_tokens: int = CHAT_MAX_TOKENS,
             temperature: float = CHAT_TEMPERATURE) -> str:
        """Send chat request and return response text."""
        try:
            if self.provider == "anthropic":
                return self._chat_anthropic(messages, max_tokens, temperature)
            return self._chat_openai(messages, max_tokens, temperature)
        except Exception as e:
            logger.error(f"LLM API error ({self.provider}): {e}")
            raise HTTPException(status_code=500, detail=f"LLM API error: {e}")

    def _chat_anthropic(self, messages: List[dict], max_tokens: int, temperature: float) -> str:
        system_msg = next((m["content"] for m in messages if m["role"] == "system"), None)
        filtered_msgs = [{"role": m["role"], "content": m["content"]} 
                        for m in messages if m["role"] != "system"]
        
        response = self.client.messages.create(
            model=self.model,
            max_tokens=max_tokens,
            temperature=temperature,
            system=system_msg,
            messages=filtered_msgs
        )
        return response.content[0].text

    def _chat_openai(self, messages: List[dict], max_tokens: int, temperature: float) -> str:
        response = self.client.chat.completions.create(
            model=self.model,
            messages=messages,
            max_tokens=max_tokens,
            temperature=temperature
        )
        return response.choices[0].message.content


# Initialize clients
llm_client: Optional[LLMClient] = None
groq_whisper_client: Optional[Groq] = None

def init_llm_client():
    global llm_client
    try:
        llm_client = LLMClient()
    except Exception as e:
        logger.warning(f"LLM client init failed: {e}")

def init_whisper_client():
    global groq_whisper_client
    api_key = os.getenv("GROQ_API_KEY")
    if api_key:
        try:
            groq_whisper_client = Groq(api_key=api_key)
            logger.info("Groq Whisper client initialized")
        except Exception as e:
            logger.warning(f"Whisper client init failed: {e}")
    else:
        logger.warning("GROQ_API_KEY not set - audio transcription disabled")

# =============================================================================
# UTILITY FUNCTIONS
# =============================================================================

@lru_cache(maxsize=1)
def read_prompt() -> str:
    """Read and cache the prompt from file."""
    try:
        with open(PROMPT_FILE_PATH, 'r', encoding='utf-8') as f:
            prompt = f.read().strip()
            return prompt if prompt else DEFAULT_PROMPT
    except FileNotFoundError:
        logger.warning(f"Prompt file not found: {PROMPT_FILE_PATH}")
        return DEFAULT_PROMPT
    except Exception as e:
        logger.error(f"Error reading prompt: {e}")
        return DEFAULT_PROMPT


def get_s3_client():
    """Create S3 client with configured credentials."""
    return boto3.client(
        's3',
        aws_access_key_id=AWS_ACCESS_KEY_ID,
        aws_secret_access_key=AWS_SECRET_ACCESS_KEY,
        region_name=AWS_REGION
    )


def parse_s3_path(s3_path: str) -> tuple[str, str]:
    """Parse s3://bucket/key into (bucket, key)."""
    if not s3_path.startswith('s3://'):
        raise ValueError("S3 path must start with 's3://'")
    parts = s3_path[5:].split('/', 1)
    return parts[0], parts[1] if len(parts) > 1 else ''


# =============================================================================
# FILE OPERATIONS
# =============================================================================

def download_file(source_url: str, local_path: str):
    """Download file from S3 or presigned URL."""
    try:
        if source_url.startswith(('http://', 'https://')):
            # Presigned URL - use streaming download
            client = get_http_client()
            with client.stream('GET', source_url) as response:
                response.raise_for_status()
                with open(local_path, 'wb') as f:
                    for chunk in response.iter_bytes(chunk_size=8192):
                        f.write(chunk)
        elif source_url.startswith('s3://'):
            bucket, key = parse_s3_path(source_url)
            get_s3_client().download_file(bucket, key, local_path)
        else:
            raise ValueError("URL must be s3:// or http(s)://")
        
        logger.info(f"Downloaded: {local_path}")
    except (httpx.HTTPError, ClientError) as e:
        logger.error(f"Download failed: {e}")
        raise HTTPException(status_code=400, detail=f"Download failed: {e}")


def run_ffmpeg(args: List[str], timeout: int = 300) -> bool:
    """Run ffmpeg command with error handling."""
    import subprocess
    try:
        subprocess.run(
            ['ffmpeg'] + args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=True
        )
        return True
    except FileNotFoundError:
        logger.error("ffmpeg not found")
        return False
    except subprocess.CalledProcessError as e:
        logger.error(f"ffmpeg error: {e.stderr.decode() if e.stderr else e}")
        return False
    except subprocess.TimeoutExpired:
        logger.error("ffmpeg timed out")
        return False


def preprocess_video(video_path: str) -> str:
    """Preprocess video for consistent format. Returns path to use."""
    output_path = video_path.rsplit('.', 1)[0] + '_preprocessed.mp4'
    
    args = [
        '-i', video_path,
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-r', '30', '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart', '-y', output_path
    ]
    
    if run_ffmpeg(args) and os.path.exists(output_path) and os.path.getsize(output_path) > 0:
        return output_path
    return video_path


def extract_audio(video_path: str) -> Optional[str]:
    """Extract audio from video file."""
    output_path = video_path.rsplit('.', 1)[0] + f'_extracted.{AUDIO_EXTRACT_FORMAT}'
    
    codec = 'libmp3lame' if AUDIO_EXTRACT_FORMAT == 'mp3' else 'copy'
    args = [
        '-i', video_path, '-vn',
        '-acodec', codec, '-ab', AUDIO_EXTRACT_BITRATE,
        '-ar', '44100', '-y', output_path
    ]
    
    if run_ffmpeg(args) and os.path.exists(output_path) and os.path.getsize(output_path) > 0:
        return output_path
    return None


def find_s3_audio(video_s3_path: str, local_dir: str) -> Optional[str]:
    """Try to find and download corresponding audio file from S3."""
    s3_dir = os.path.dirname(video_s3_path)
    basename = os.path.splitext(os.path.basename(video_s3_path))[0]
    
    for ext in AUDIO_EXTENSIONS:
        audio_s3_path = f"{s3_dir}/{basename}{ext}"
        local_path = os.path.join(local_dir, f"{basename}{ext}")
        try:
            bucket, key = parse_s3_path(audio_s3_path)
            get_s3_client().download_file(bucket, key, local_path)
            logger.info(f"Found S3 audio: {audio_s3_path}")
            return local_path
        except Exception:
            continue
    return None


def get_audio_for_video(video_path: str, video_s3_path: str) -> Optional[str]:
    """Get audio based on configured mode."""
    local_dir = os.path.dirname(video_path)
    
    if AUDIO_SOURCE_MODE == "separate":
        return find_s3_audio(video_s3_path, local_dir)
    elif AUDIO_SOURCE_MODE == "extract":
        return extract_audio(video_path)
    elif AUDIO_SOURCE_MODE == "both":
        audio = find_s3_audio(video_s3_path, local_dir)
        return audio if audio else extract_audio(video_path)
    return None


# =============================================================================
# AUDIO TRANSCRIPTION
# =============================================================================

def transcribe_audio(audio_path: str) -> Optional[str]:
    """Transcribe audio using Groq Whisper."""
    if not groq_whisper_client:
        return None
    
    try:
        logger.info(f"Transcribing: {audio_path}")
        with open(audio_path, "rb") as f:
            result = groq_whisper_client.audio.transcriptions.create(
                file=(os.path.basename(audio_path), f.read()),
                model=WHISPER_MODEL,
                temperature=0,
                response_format="verbose_json",
            )
        text = getattr(result, 'text', str(result))
        logger.info(f"Transcription: {len(text)} chars")
        return text
    except Exception as e:
        logger.error(f"Transcription error: {e}")
        return None


# =============================================================================
# MODEL FUNCTIONS
# =============================================================================

def build_bnb_config(quant: str):
    """Build quantization config."""
    if quant == "8-bit":
        return BitsAndBytesConfig(load_in_8bit=True)
    if quant == "4-bit":
        return BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_compute_dtype=torch.float16)
    return None


def pick_model_class(model_id: str):
    """Select model class based on model ID."""
    from transformers import AutoModelForVision2Seq
    try:
        if "Qwen3-VL" in model_id:
            from transformers import Qwen3VLForConditionalGeneration
            return Qwen3VLForConditionalGeneration
        if "Qwen2.5-VL" in model_id or "Qwen2_5-VL" in model_id:
            from transformers import Qwen2_5_VLForConditionalGeneration
            return Qwen2_5_VLForConditionalGeneration
    except ImportError:
        pass
    return AutoModelForVision2Seq


def load_model():
    """Load VLM model and processor."""
    global model, processor
    
    logger.info(f"Loading model: {MODEL_ID} (quant={QUANTIZATION}, attn={ATTENTION_IMPL})")
    
    kwargs = {
        "dtype": torch.float16,
        "device_map": "auto",
        "attn_implementation": ATTENTION_IMPL,
    }
    
    bnb = build_bnb_config(QUANTIZATION)
    if bnb:
        kwargs["quantization_config"] = bnb
    
    ModelCls = pick_model_class(MODEL_ID)
    
    try:
        model = ModelCls.from_pretrained(MODEL_ID, **kwargs)
    except Exception as e:
        if ATTENTION_IMPL == "flash_attention_2":
            logger.warning(f"Flash attention failed, using eager: {e}")
            kwargs["attn_implementation"] = "eager"
            model = ModelCls.from_pretrained(MODEL_ID, **kwargs)
        else:
            raise
    
    from transformers import AutoProcessor
    processor = AutoProcessor.from_pretrained(MODEL_ID, use_fast=True)
    logger.info("Model loaded successfully")


def unload_model():
    """Unload model and free memory."""
    global model, processor
    model = processor = None
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    logger.info("Model unloaded")


def generate_caption(video_path: str, prompt: str, transcript: Optional[str] = None) -> str:
    """Generate video caption."""
    if not model or not processor:
        raise RuntimeError("Model not loaded")
    
    # Validate file
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")
    
    ext = os.path.splitext(video_path)[-1].lower()
    if ext not in VIDEO_EXTENSIONS:
        raise ValueError(f"Unsupported format: {ext}")
    
    # Preprocess video
    video_path = preprocess_video(video_path)
    
    # Build prompt with transcript context
    full_prompt = prompt
    if transcript and USE_AUDIO_GUARDRAIL:
        full_prompt = f"{prompt}\n\nAudio transcript for context:\n{transcript}"
    
    # Build messages
    messages = [{
        "role": "user",
        "content": [
            {"type": "video", "video": video_path},
            {"type": "text", "text": full_prompt},
        ],
    }]
    
    # Process inputs
    text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    vision_info = process_vision_info(messages)
    
    if len(vision_info) == 3:
        image_inputs, video_inputs, _ = vision_info
    else:
        image_inputs, video_inputs = vision_info[:2]
    
    inputs = processor(
        text=[text],
        images=image_inputs,
        videos=video_inputs,
        padding=True,
        return_tensors="pt",
    ).to("cuda" if torch.cuda.is_available() else "cpu")
    
    # Generate
    with torch.no_grad():
        generated_ids = model.generate(**inputs, max_new_tokens=MAX_TOKENS)
    
    trimmed_ids = [out[len(inp):] for inp, out in zip(inputs.input_ids, generated_ids)]
    caption = processor.batch_decode(trimmed_ids, skip_special_tokens=True)[0]
    
    logger.info(f"Caption generated ({len(caption)} chars)")
    return caption


# =============================================================================
# WEBHOOK
# =============================================================================

def send_to_webhook(video_url: str, message: str, job_id: Optional[str] = None) -> dict:
    """Send result to webhook endpoint."""
    if not CAPTION_RESULT_ENDPOINT:
        logger.warning("No webhook endpoint configured")
        return {"status": "no-endpoint"}
    
    payload = {"message": message, "id": job_id}
    
    try:
        client = get_http_client()
        response = client.post(
            CAPTION_RESULT_ENDPOINT,
            json=payload,
            headers=get_webhook_headers(),
            timeout=RESULT_API_TIMEOUT
        )
        response.raise_for_status()
        logger.info(f"Webhook sent: {response.status_code}")
        return response.json() if response.headers.get('content-type', '').startswith('application/json') else {"status": "success"}
    except Exception as e:
        logger.error(f"Webhook failed: {e}")
        raise HTTPException(status_code=500, detail=f"Webhook failed: {e}")


# =============================================================================
# BACKGROUND JOBS
# =============================================================================

def process_caption_job(video_url: str, job_id: Optional[str]):
    """Background job for video captioning."""
    temp_files = []
    
    try:
        prompt = read_prompt()
        logger.info(f"[{job_id}] Starting caption job")
        
        # Create temp file for video
        ext = os.path.splitext(video_url.split('?')[0])[-1] or '.mp4'
        with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as f:
            temp_video = f.name
        temp_files.append(temp_video)
        
        # Download video
        download_file(video_url, temp_video)
        
        # Get audio transcript if enabled
        transcript = None
        if USE_AUDIO_GUARDRAIL and groq_whisper_client:
            audio_path = get_audio_for_video(temp_video, video_url)
            if audio_path:
                temp_files.append(audio_path)
                transcript = transcribe_audio(audio_path)
        
        # Generate caption
        caption = generate_caption(temp_video, prompt, transcript)
        
        # Send to webhook
        send_to_webhook(video_url, caption, job_id)
        logger.info(f"[{job_id}] Caption job completed")
        
    except Exception as e:
        logger.exception(f"[{job_id}] Caption job failed: {e}")
        try:
            send_to_webhook(video_url, f"ERROR: {e}", job_id)
        except Exception:
            pass
    finally:
        # Cleanup temp files
        for path in temp_files:
            cleanup_file(path)
            # Also check for preprocessed version
            preprocessed = path.rsplit('.', 1)[0] + '_preprocessed.mp4'
            cleanup_file(preprocessed)


def process_chat_job(request: "ChatRequest"):
    """Background job for chat."""
    try:
        if not llm_client:
            raise RuntimeError("LLM client not initialized")
        
        # Build messages
        messages = [{"role": "system", "content": request.system_prompt or CHAT_SYSTEM_PROMPT}]
        
        if request.initial_content:
            messages.append({
                "role": "system",
                "content": f"Initial content from user:\n\n{request.initial_content}"
            })
        
        messages.extend({"role": m.role, "content": m.content} for m in request.history)
        messages.append({"role": "user", "content": request.message})
        
        # Get response
        response = llm_client.chat(
            messages,
            max_tokens=request.max_tokens or CHAT_MAX_TOKENS,
            temperature=request.temperature or CHAT_TEMPERATURE
        )
        
        # Send to webhook
        send_to_webhook("", response, request.job_id)
        logger.info(f"[{request.job_id}] Chat completed")
        
    except Exception as e:
        logger.exception(f"[{request.job_id}] Chat failed: {e}")
        try:
            send_to_webhook("", f"ERROR: {e}", request.job_id)
        except Exception:
            pass


def cleanup_file(path: str):
    """Safely remove a file."""
    if path and os.path.exists(path):
        try:
            os.remove(path)
            logger.debug(f"Cleaned up: {path}")
        except Exception as e:
            logger.warning(f"Cleanup failed for {path}: {e}")


# =============================================================================
# FASTAPI APP
# =============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown events."""
    logger.info("Starting up...")
    init_llm_client()
    init_whisper_client()
    try:
        load_model()
    except Exception as e:
        logger.error(f"Model load failed: {e}")
    yield
    logger.info("Shutting down...")
    unload_model()
    if http_client:
        http_client.close()


app = FastAPI(
    title="Video Caption API",
    description="API for generating video captions using VLM",
    version="2.0.0",
    lifespan=lifespan
)


# =============================================================================
# REQUEST/RESPONSE MODELS
# =============================================================================

class CaptionRequest(BaseModel):
    video_url: str = Field(..., description="S3 path or presigned URL to video")
    job_id: Optional[str] = Field(None, description="Job tracking ID")


class CaptionResponse(BaseModel):
    status: str
    job_id: Optional[str] = None
    video_url: Optional[str] = None
    message: Optional[str] = None
    error: Optional[str] = None


class ChatMessage(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: str


class ChatRequest(BaseModel):
    job_id: str = Field(..., description="Job ID")
    message: str = Field(..., description="User message")
    history: List[ChatMessage] = Field(default_factory=list)
    initial_content: Optional[str] = None
    system_prompt: Optional[str] = None
    max_tokens: Optional[int] = None
    temperature: Optional[float] = None


class ChatResponse(BaseModel):
    status: str
    job_id: str
    message: Optional[str] = None
    error: Optional[str] = None


# =============================================================================
# ENDPOINTS
# =============================================================================

@app.get("/")
async def root():
    """API information."""
    return {
        "service": "Video Caption API",
        "version": "2.0.0",
        "model": MODEL_ID,
        "status": "running"
    }


@app.get("/health")
async def health():
    """Health check."""
    loaded = model is not None and processor is not None
    return {
        "status": "healthy" if loaded else "degraded",
        "model_loaded": loaded,
        "llm_available": llm_client is not None,
        "whisper_available": groq_whisper_client is not None,
        "cuda": torch.cuda.is_available()
    }


@app.post("/caption", response_model=CaptionResponse)
async def create_caption(
    background_tasks: BackgroundTasks,
    body: Optional[CaptionRequest] = Body(None),
    video_url: Optional[str] = Query(None),
    job_id: Optional[str] = Query(None)
):
    """
    Generate caption for a video (async).
    Returns immediately; result sent to webhook.
    """
    url = body.video_url if body else video_url
    jid = body.job_id if body else job_id
    
    if not url:
        raise HTTPException(400, "video_url required")
    
    background_tasks.add_task(process_caption_job, url, jid)
    
    return CaptionResponse(
        status="accepted",
        job_id=jid,
        video_url=url,
        message="Processing started"
    )


@app.post("/chat", response_model=ChatResponse)
async def chat(
    background_tasks: BackgroundTasks,
    body: Optional[ChatRequest] = Body(None),
    job_id: Optional[str] = Query(None),
    message: Optional[str] = Query(None)
):
    """
    Chat endpoint (async).
    Returns immediately; result sent to webhook.
    """
    if body:
        request = body
    elif job_id and message:
        request = ChatRequest(job_id=job_id, message=message)
    else:
        raise HTTPException(400, "Provide JSON body or job_id + message params")
        
    background_tasks.add_task(process_chat_job, request)
    
    return ChatResponse(
        status="accepted",
        job_id=request.job_id,
        message="Processing started"
    )


@app.get("/config")
async def get_config():
    """Current configuration."""
    return {
        "model_id": MODEL_ID,
        "quantization": QUANTIZATION,
        "attention_impl": ATTENTION_IMPL,
        "max_tokens": MAX_TOKENS,
        "llm_provider": LLM_PROVIDER,
        "llm_model": llm_client.model if llm_client else None,
        "audio_guardrail": USE_AUDIO_GUARDRAIL,
        "audio_source_mode": AUDIO_SOURCE_MODE,
        "whisper_model": WHISPER_MODEL,
        "whisper_available": groq_whisper_client is not None
    }


# =============================================================================
# MAIN
# =============================================================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8501)