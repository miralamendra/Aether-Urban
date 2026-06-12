import json
import os
import re
import time
import traceback
from pathlib import Path

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import StreamingResponse, FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from google import genai
from google.genai import types

import spatial_tools

# ── Security: Load env vars from .env if present and read API key ────────────
env_path = Path(__file__).parent / ".env"
if env_path.exists():
    try:
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ[k.strip()] = v.strip()
    except Exception as e:
        print(f"Error reading .env file: {e}")

API_KEY = os.environ.get("GEMINI_API_KEY", "")
if not API_KEY:
    print("WARNING: GEMINI_API_KEY not set. Gemini provider will be unavailable.")

MODEL = "gemma-4-31b-it"
MAX_TOOL_ITERATIONS = 10
MAX_HISTORY_ENTRIES = 20
MAX_MESSAGE_LENGTH = 4000

# ── Enhanced System Prompt: Full AI Agent ─────────────────────────────────────
SYSTEM_PROMPT = """You are Aether, an expert geospatial analysis AI agent for urban planning in Colombo, Sri Lanka. You have access to GIS layers including buildings (90,310 features), land use (13,819 features), zoning (3,871 features), and roads (2,761 features).

LAYER SCHEMAS (Avoid calling schema inspection tools unless absolutely necessary):
- `building`: Columns include `main_use` (e.g. Residential, Commercial), `ownership`, `condition`, `status`, `present_us`, `st_area(sh`.
- `land_use`: Columns include `remarks`, `discriptio` (primary land use category, e.g. "Residential", "Commercial", "Water Bodies", "Open Space"), `descriptio`, `local_auth`, `area_hecta`.
- `zoning`: Columns include `zone` (zoning category), `area_hecta`.
- `road`: Columns include `name`, `road_class` (e.g. A, B class).

Available tools:
1. get_overview() - Get overview of all available data layers
2. get_layer_summary(layer_name) - Get statistics for a layer (building, land_use, zoning, road)
3. get_layer_columns(layer_name) - Get column info for a layer
4. get_unique_values(layer_name, column_name) - Get unique values in a column
5. filter_features(layer_name, attribute, value) - Filter features by attribute
6. calculate_area_by_category(layer_name, category_column) - Area breakdown by category
7. proximity_analysis(layer_name, attribute, value, buffer_meters) - Buffer analysis
8. spatial_intersection(layer1_name, layer2_name, filter_attr, filter_val) - Overlay analysis
9. nearest_features(layer_name, lat, lon, n) - Find nearest features to a point
10. get_network_isochrone(lat, lon, walk_time_minutes) - Walking accessibility isochrone
11. get_walking_route(start_lat, start_lon, end_lat, end_lon) - Walking route calculation
12. zoning_compliance_check(lat, lon, proposed_use) - Zoning compliance verification

CRITICAL AGENT BEHAVIOR:
1. You are a FULL AI AGENT. When the user asks ANY spatial question, you MUST call the appropriate tool(s). This is the ONLY way the map gets updated. Never answer from memory alone.
2. THINK STEP-BY-STEP: Before calling tools, briefly explain your reasoning. For example: "I'll filter the building layer by main_use = 'Commercial' to show all commercial buildings on the map and provide area statistics."
3. ALWAYS PROVIDE ANALYSIS: After receiving tool results, provide RICH analytical text including:
   - Summary of findings (counts, areas, percentages)
   - Spatial patterns or insights
   - Recommendations or notable observations
   - Comparisons where relevant
4. COMPOUND QUERIES: For complex questions, call MULTIPLE tools in a single turn. For example:
   - "Commercial buildings near schools" → call filter_features for commercial, then proximity_analysis
   - "Land use composition" → call calculate_area_by_category
5. NATURAL LANGUAGE MAPPING: Map common phrases to the correct tool calls:
   - "show me X buildings" → filter_features("building", "main_use", "X")
   - "vacant lands" → filter_features("land_use", "discriptio", "Vacant")
   - "water bodies" → filter_features("land_use", "discriptio", "Water")
   - "zone breakdown" → calculate_area_by_category("zoning", "zone")
   - "road network" → get_layer_summary("road") or calculate_area_by_category("road", "road_class")
   - "buildings near X" → proximity_analysis("building", "main_use", "X", 500)
6. PARALLEL TOOL CALLS: Call all relevant tools at once to minimize API rounds.

To call tools, output a JSON list inside a single ```tool block:
```tool
[
  {"name": "function_name1", "args": {"param1": "value1"}},
  {"name": "function_name2", "args": {"param2": "value2"}}
]
```

After receiving results, provide an insightful markdown-formatted analysis. Use tables, bullet points, and bold text for clarity. Always reference specific numbers from the data."""

TOOL_REGISTRY = {
    "get_overview": spatial_tools.get_overview,
    "get_layer_summary": spatial_tools.get_layer_summary,
    "get_layer_columns": spatial_tools.get_layer_columns,
    "get_unique_values": spatial_tools.get_unique_values,
    "filter_features": spatial_tools.filter_features,
    "calculate_area_by_category": spatial_tools.calculate_area_by_category,
    "proximity_analysis": spatial_tools.proximity_analysis,
    "spatial_intersection": spatial_tools.spatial_intersection,
    "nearest_features": spatial_tools.nearest_features,
    "get_network_isochrone": spatial_tools.get_network_isochrone,
    "get_walking_route": spatial_tools.get_walking_route,
    "zoning_compliance_check": spatial_tools.zoning_compliance_check,
}

VALID_TOOL_NAMES = frozenset(TOOL_REGISTRY.keys())

client = genai.Client(api_key=API_KEY) if API_KEY else None

app = FastAPI(title="Aether-Urban")

# ── Security: CORS — don't mix wildcard origins with credentials ─────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

# ── Performance: Enable Gzip compression for large GeoJSON responses ─────────
app.add_middleware(GZipMiddleware, minimum_size=1000)

# ── Performance: Pre-warm spatial data caches on container startup ──────────
@app.on_event("startup")
async def startup_event():
    print("Pre-warming spatial data caches...")
    try:
        # Pre-load all data layers in memory
        for layer in ["building", "land_use", "zoning", "road"]:
            spatial_tools._load_layer(layer)
        # Pre-load and project the walk graph
        spatial_tools._load_walk_graph()
        print("All spatial data caches successfully pre-warmed!")
    except Exception as e:
        print(f"Error during cache pre-warming: {e}")

static_dir = Path(__file__).parent / "static"
if static_dir.exists():
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


def sse_event(event_type: str, content) -> str:
    payload = json.dumps({"type": event_type, "content": content}, default=str)
    return f"data: {payload}\n\n"


def extract_tool_calls(text: str):
    pattern = r"```(?:tool|json)\s*\n(.*?)\n?```"
    match = re.search(pattern, text, re.DOTALL | re.IGNORECASE)
    if match:
        try:
            tool_data = json.loads(match.group(1).strip())
            if isinstance(tool_data, list):
                return tool_data
            elif isinstance(tool_data, dict):
                return [tool_data]
        except json.JSONDecodeError:
            return None
    return None


def strip_tool_block(text: str) -> str:
    return re.sub(r"```tool\s*\n.*?\n```", "", text, flags=re.DOTALL).strip()


def execute_tool(tool_name: str, args: dict):
    """Execute a tool with validation. Tracebacks logged server-side only."""
    if tool_name not in VALID_TOOL_NAMES:
        return {"error": f"Unknown tool: {tool_name}"}
    try:
        # Sanitize args — only allow string/number/bool values
        clean_args = {}
        for k, v in args.items():
            if isinstance(v, (str, int, float, bool)):
                clean_args[k] = v
            else:
                clean_args[k] = str(v)
        func = TOOL_REGISTRY[tool_name]
        return func(**clean_args)
    except Exception as e:
        traceback.print_exc()  # Log server-side
        return {"error": f"Tool execution failed: {type(e).__name__}: {str(e)}"}


def build_contents(message: str, history: list) -> list:
    contents = []
    for entry in history:
        role = "user" if entry["role"] == "user" else "model"
        contents.append(types.Content(role=role, parts=[types.Part(text=entry["content"])]))
    contents.append(types.Content(role="user", parts=[types.Part(text=message)]))
    return contents


def clean_value(val, depth=0):
    if depth > 5:
        return "<depth limit reached>"
    if isinstance(val, dict):
        if "type" in val and ("features" in val or "coordinates" in val or "geometries" in val):
            feature_count = len(val.get("features", [])) if "features" in val else 0
            if feature_count > 0:
                return f"<GeoJSON {val.get('type')} with {feature_count} features, omitted for token economy>"
            return f"<GeoJSON {val.get('type')} omitted>"
        cleaned_dict = {}
        for k, v in val.items():
            if k in ("geojson", "geometry", "buffer_geojson"):
                cleaned_dict[k] = f"<geometry data of type {type(v).__name__} omitted for token economy>"
            else:
                cleaned_dict[k] = clean_value(v, depth + 1)
        return cleaned_dict
    elif isinstance(val, list):
        if val and isinstance(val[0], (int, float)) and len(val) > 4:
            return f"<Coordinates list of size {len(val)} omitted>"
        if len(val) > 50:
            return [clean_value(x, depth + 1) for x in val[:15]] + [f"... truncated {len(val) - 20} items to avoid token exhaustion ..."] + [clean_value(val[-1], depth + 1)]
        else:
            return [clean_value(x, depth + 1) for x in val]
    else:
        return val


def _sanitize_input(message: str, history: list):
    """Enforce size limits on user input."""
    message = message[:MAX_MESSAGE_LENGTH] if message else ""
    history = history[-MAX_HISTORY_ENTRIES:] if history else []
    # Ensure history entries have required fields
    clean_history = []
    for entry in history:
        if isinstance(entry, dict) and "role" in entry and "content" in entry:
            clean_history.append({
                "role": str(entry["role"])[:10],
                "content": str(entry["content"])[:MAX_MESSAGE_LENGTH * 2],
            })
    return message, clean_history

class StreamParserState:
    def __init__(self, is_first_turn):
        self.is_first_turn = is_first_turn
        self.processed_idx = 0
        self.in_tool_block = False
        self.tool_block_buffer = ""
        self.full_response = ""

def is_spatial_query(message: str) -> bool:
    spatial_keywords = [
        "building", "land", "zone", "road", "map", "isochrone", "route", "buffer", 
        "spatial", "gis", "layer", "intersection", "proximity", "nearest", "area",
        "district", "colombo", "ward", "zoning", "compliance"
    ]
    message_lower = message.lower()
    return any(kw in message_lower for kw in spatial_keywords)

def process_stream_chunk(chunk_text, state: StreamParserState):
    state.full_response += chunk_text
    events = []
    
    while state.processed_idx < len(state.full_response):
        remaining = state.full_response[state.processed_idx:]
        
        if not state.in_tool_block:
            triple_backtick_idx = remaining.find("```")
            if triple_backtick_idx != -1:
                before_text = remaining[:triple_backtick_idx]
                if before_text:
                    events.append((
                        "thinking" if state.is_first_turn else "text",
                        before_text
                    ))
                    state.processed_idx += triple_backtick_idx
                
                rest = remaining[triple_backtick_idx:]
                if not re.search(r"[\r\n\s]", rest) and len(rest) < 10:
                    break
                
                if rest.startswith("```tool") or rest.startswith("```json"):
                    state.in_tool_block = True
                    header_match = re.match(r"^```(?:tool|json)\s*", rest)
                    if header_match:
                        header_len = len(header_match.group(0))
                        state.processed_idx += header_len
                    else:
                        state.processed_idx += 3
                else:
                    events.append((
                        "thinking" if state.is_first_turn else "text",
                        "```"
                    ))
                    state.processed_idx += 3
            else:
                keep_len = 0
                if remaining.endswith("``"):
                    keep_len = 2
                elif remaining.endswith("`"):
                    keep_len = 1
                
                yield_text = remaining[:-keep_len] if keep_len > 0 else remaining
                if yield_text:
                    events.append((
                        "thinking" if state.is_first_turn else "text",
                        yield_text
                    ))
                state.processed_idx += len(remaining) - keep_len
                break
        else:
            closing_idx = remaining.find("```")
            if closing_idx != -1:
                state.tool_block_buffer += remaining[:closing_idx]
                state.tool_block_buffer = ""
                state.in_tool_block = False
                state.processed_idx += closing_idx + 3
            else:
                keep_len = 0
                if remaining.endswith("``"):
                    keep_len = 2
                elif remaining.endswith("`"):
                    keep_len = 1
                
                state.tool_block_buffer += remaining[:-keep_len] if keep_len > 0 else remaining
                state.processed_idx += len(remaining) - keep_len
                break
    return events

def flush_stream_parser(state: StreamParserState):
    events = []
    if state.processed_idx < len(state.full_response):
        remaining = state.full_response[state.processed_idx:]
        if state.in_tool_block:
            state.tool_block_buffer += remaining
            state.tool_block_buffer = ""
        else:
            events.append((
                "thinking" if state.is_first_turn else "text",
                remaining
            ))
        state.processed_idx = len(state.full_response)
    return events


async def ollama_chat_stream(message: str, history: list):
    try:
        messages = [{"role": "system", "content": SYSTEM_PROMPT}]
        for entry in history:
            role = "user" if entry["role"] == "user" else "assistant"
            messages.append({"role": role, "content": entry["content"]})
        messages.append({"role": "user", "content": message})

        model_name = "qwen2.5-coder:7b"
        async with httpx.AsyncClient(timeout=60.0) as http_client:
            try:
                r_tags = await http_client.get("http://localhost:11434/api/tags")
                if r_tags.status_code == 200:
                    tags = r_tags.json()
                    available_models = [m["name"] for m in tags.get("models", [])]
                    for m in available_models:
                        if "coder" in m or "qwen" in m:
                            model_name = m
                            break
                    else:
                        if available_models:
                            model_name = available_models[0]
            except Exception:
                raise ConnectionError("Ollama is not running. Please make sure Ollama is started on localhost:11434.")

            payload = {
                "model": model_name,
                "messages": messages,
                "stream": True,
                "options": {
                    "temperature": 0.3
                }
            }
            
            is_spatial = is_spatial_query(message)
            for iteration in range(MAX_TOOL_ITERATIONS):
                is_first_turn = (iteration == 0) and is_spatial
                parser_state = StreamParserState(is_first_turn)
                
                async with http_client.stream("POST", "http://localhost:11434/api/chat", json=payload) as r:
                    if r.status_code != 200:
                        err_text = await r.aread()
                        raise ValueError(f"Ollama returned status {r.status_code}: {err_text.decode('utf-8', errors='ignore')}")
                        
                    async for line in r.aiter_lines():
                        if line:
                            chunk = json.loads(line)
                            content = chunk.get("message", {}).get("content", "")
                            for ev_type, ev_content in process_stream_chunk(content, parser_state):
                                yield sse_event(ev_type, ev_content)
                
                for ev_type, ev_content in flush_stream_parser(parser_state):
                    yield sse_event(ev_type, ev_content)
                
                full_response = parser_state.full_response
                tool_calls = extract_tool_calls(full_response)
                
                if not tool_calls:
                    if is_first_turn:
                        yield sse_event("text", strip_tool_block(full_response))
                    break
                    
                results = []
                for tc in tool_calls:
                    tool_name = tc.get("name", "")
                    tool_args = tc.get("args", {})
                    yield sse_event("tool_call", {"name": tool_name, "args": tool_args})
                    
                    result = execute_tool(tool_name, tool_args)
                    results.append({"tool": tool_name, "result": result})
                    
                    if isinstance(result, dict) and "map_action" in result:
                        yield sse_event("map_action", result["map_action"])
                        
                    yield sse_event("tool_result", result)
                    
                messages.append({"role": "assistant", "content": full_response})
                sanitized_results = clean_value(results)
                result_text = json.dumps(sanitized_results, default=str)
                messages.append({"role": "user", "content": f"Tool results:\n{result_text}"})
                
                payload["messages"] = messages
                
            else:
                yield sse_event("text", "Maximum tool iterations reached. Here is what I found so far.")
                
            yield sse_event("done", "")
        
    except Exception as e:
        traceback.print_exc()
        yield sse_event("error", f"Local Ollama error: {type(e).__name__}: {str(e)}")
        yield sse_event("done", "")


async def chat_stream(message: str, history: list, provider: str = "gemini"):
    # Sanitize inputs
    message, history = _sanitize_input(message, history)

    if provider == "ollama":
        async for event in ollama_chat_stream(message, history):
            yield event
        return

    if not client:
        yield sse_event("thinking", "Gemini API key not configured. Falling back to local Ollama...")
        async for event in ollama_chat_stream(message, history):
            yield event
        return

    try:
        contents = build_contents(message, history)
        config = types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            temperature=0.3,
        )

        gemini_failed = False
        is_spatial = is_spatial_query(message)
        for iteration in range(MAX_TOOL_ITERATIONS):
            is_first_turn = (iteration == 0) and is_spatial
            parser_state = StreamParserState(is_first_turn)
            last_err = None
            success = False

            for attempt in range(3):
                try:
                    response = client.models.generate_content_stream(
                        model=MODEL,
                        contents=contents,
                        config=config,
                    )
                    for chunk in response:
                        if chunk.text:
                            for ev_type, ev_content in process_stream_chunk(chunk.text, parser_state):
                                yield sse_event(ev_type, ev_content)
                    
                    for ev_type, ev_content in flush_stream_parser(parser_state):
                        yield sse_event(ev_type, ev_content)
                    
                    success = True
                    break
                except Exception as e:
                    traceback.print_exc()
                    print(f"Attempt {attempt + 1} for {MODEL} failed: {type(e).__name__}: {str(e)}")
                    last_err = e
                    if "429" in str(e) and "quota" in str(e).lower():
                        break
                    time.sleep(1.5 * (attempt + 1))
            
            if not success:
                gemini_failed = True
                break

            full_response = parser_state.full_response
            tool_calls = extract_tool_calls(full_response)

            if not tool_calls:
                if is_first_turn:
                    yield sse_event("text", strip_tool_block(full_response))
                break

            results = []
            for tc in tool_calls:
                tool_name = tc.get("name", "")
                tool_args = tc.get("args", {})
                yield sse_event("tool_call", {"name": tool_name, "args": tool_args})

                result = execute_tool(tool_name, tool_args)
                results.append({"tool": tool_name, "result": result})

                if isinstance(result, dict) and "map_action" in result:
                    yield sse_event("map_action", result["map_action"])

                yield sse_event("tool_result", result)

            contents.append(types.Content(role="model", parts=[types.Part(text=full_response)]))
            sanitized_results = clean_value(results)
            result_text = json.dumps(sanitized_results, default=str)
            contents.append(types.Content(role="user", parts=[types.Part(text=f"Tool results:\n{result_text}")]))
        else:
            yield sse_event("text", "Maximum tool iterations reached. Here is what I found so far.")

        if not gemini_failed:
            yield sse_event("done", "")
            return

    except Exception as e:
        traceback.print_exc()
        print(f"Gemini agent exception: {type(e).__name__}: {str(e)}, falling back to Ollama...")
        gemini_failed = True

    if gemini_failed:
        yield sse_event("thinking", "Gemini API unavailable. Falling back to local Ollama (Qwen2.5-Coder)...")
        async for event in ollama_chat_stream(message, history):
            yield event


@app.get("/")
async def root():
    index_path = static_dir / "index.html"
    if index_path.exists():
        return FileResponse(str(index_path))
    return JSONResponse({"status": "Aether-Urban API running"})


@app.post("/api/chat")
async def chat_endpoint(request: Request):
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON body"}, status_code=400)
    message = body.get("message", "")
    history = body.get("history", [])
    provider = body.get("provider", "gemini")
    if not message or not isinstance(message, str):
        return JSONResponse({"error": "Message is required"}, status_code=400)
    if provider not in ("gemini", "ollama"):
        provider = "gemini"
    return StreamingResponse(
        chat_stream(message, history, provider),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "Content-Encoding": "identity",
        },
    )


@app.get("/api/layers")
async def get_layers():
    try:
        result = spatial_tools.get_overview()
        return JSONResponse(result)
    except Exception as e:
        traceback.print_exc()
        return JSONResponse({"error": "Failed to load layers"}, status_code=500)


@app.get("/api/layer/{name}/geojson")
async def get_layer_geojson(name: str, request: Request):
    # Validate layer name
    if name not in spatial_tools.LAYER_MAP:
        return JSONResponse({"error": f"Invalid layer: {name}"}, status_code=400)
    try:
        params = dict(request.query_params)
        filter_attr = params.get("attribute")
        filter_val = params.get("value")
        bbox = params.get("bbox")
        
        if filter_attr and filter_val:
            result = spatial_tools.filter_features(name, filter_attr, filter_val)
            return JSONResponse(result)
        else:
            gdf = spatial_tools._load_layer(name)
            if bbox:
                gdf_filtered = spatial_tools._filter_by_bbox(gdf, bbox)
                
                # Limit features to keep serialization fast and payload sizes small
                max_features = 3000
                if len(gdf_filtered) > max_features:
                    gdf_filtered = gdf_filtered.sample(n=max_features, random_state=42).copy()
                
                # Dynamic geometry simplification to optimize client-side rendering
                try:
                    parts = [float(x.strip()) for x in bbox.split(",")]
                    span_lon = abs(parts[2] - parts[0])
                    span_lat = abs(parts[3] - parts[1])
                    span = max(span_lon, span_lat)
                    
                    # Simplify based on viewport scale
                    tolerance = span / 3000.0
                    if tolerance > 0.000002:
                        gdf_filtered = gdf_filtered.copy()
                        simplified = gdf_filtered.geometry.simplify(tolerance, preserve_topology=False)
                        empty_mask = simplified.is_empty
                        final_geom = simplified.copy()
                        if empty_mask.any():
                            final_geom[empty_mask] = gdf_filtered.geometry[empty_mask].envelope
                        gdf_filtered["geometry"] = final_geom
                except Exception as se:
                    print(f"Error simplifying geometries for layer {name}: {se}")
                
                geojson_str = spatial_tools._safe_geojson_str(gdf_filtered, max_features=None)
                response_str = f'{{"status":"success","count":{len(gdf_filtered)},"geojson":{geojson_str}}}'
                return Response(content=response_str, media_type="application/json")
            else:
                # Performance: Simplify full layers to keep transmission size small
                try:
                    gdf_simplified = gdf.copy()
                    # Apply a small simplification tolerance (approx 5m resolution)
                    simplified = gdf_simplified.geometry.simplify(0.00005, preserve_topology=False)
                    empty_mask = simplified.is_empty
                    final_geom = simplified.copy()
                    if empty_mask.any():
                        final_geom[empty_mask] = gdf_simplified.geometry[empty_mask].envelope
                    gdf_simplified["geometry"] = final_geom
                    gdf = gdf_simplified
                except Exception as se:
                    print(f"Error simplifying full layer {name}: {se}")
                
                geojson_str = spatial_tools._safe_geojson_str(gdf, max_features=None)
                response_str = f'{{"status":"success","count":{len(gdf)},"geojson":{geojson_str}}}'
                return Response(content=response_str, media_type="application/json")
    except Exception as e:
        traceback.print_exc()
        return JSONResponse({"error": "Failed to load layer data"}, status_code=500)


@app.post("/api/tool/{tool_name}")
async def execute_tool_endpoint(tool_name: str, request: Request):
    # Validate tool name against whitelist
    if tool_name not in VALID_TOOL_NAMES:
        return JSONResponse({"error": f"Unknown tool: {tool_name}"}, status_code=404)
    try:
        body = await request.json()
        args = body.get("args", {})
        if not isinstance(args, dict):
            return JSONResponse({"error": "args must be a dictionary"}, status_code=400)
        result = execute_tool(tool_name, args)
        return JSONResponse(json.loads(json.dumps(result, default=str)))
    except json.JSONDecodeError:
        return JSONResponse({"error": "Invalid JSON body"}, status_code=400)
    except Exception as e:
        traceback.print_exc()
        return JSONResponse({"error": "Tool execution failed"}, status_code=500)


if __name__ == "__main__":
    import uvicorn
    import os
    port = int(os.environ.get("PORT", 8080))
    uvicorn.run("app:app", host="0.0.0.0", port=port)
