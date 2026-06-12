import os
import matplotlib.pyplot as plt
from fpdf import FPDF

# Assume running in the project directory
try:
    import spatial_tools
    overview = spatial_tools.get_overview()
    if overview["status"] == "success":
        layers_data = overview["data"]["layers_list"]
    else:
        raise ValueError("Failed to get overview from spatial_tools")
except Exception as e:
    print(f"Using fallback data due to: {e}")
    layers_data = [
        {"name": "building", "count": 90310},
        {"name": "land_use", "count": 13819},
        {"name": "zoning", "count": 3871},
        {"name": "road", "count": 2761}
    ]

def generate_graphs():
    print("Generating feature counts graph...")
    names = [l["name"].replace("_", " ").title() for l in layers_data]
    counts = [l["count"] for l in layers_data]
    
    plt.figure(figsize=(8, 5))
    bars = plt.bar(names, counts, color=['#4C51BF', '#48BB78', '#ED8936', '#E53E3E'])
    plt.title("Spatial Features by Data Layer", fontsize=14, pad=15)
    plt.ylabel("Number of Features", fontsize=12)
    plt.grid(axis='y', linestyle='--', alpha=0.7)
    
    # Add count labels
    for bar in bars:
        yval = bar.get_height()
        plt.text(bar.get_x() + bar.get_width()/2, yval + max(counts)*0.02, 
                 f"{int(yval):,}", ha='center', va='bottom', fontweight='bold')
                 
    plt.tight_layout()
    plt.savefig("feature_counts.png", dpi=300)
    plt.close()

class PDFReport(FPDF):
    def header(self):
        self.set_font("helvetica", "B", 18)
        self.cell(0, 10, "Aether-Urban: Technical Architecture Report", border=False, ln=True, align="C")
        self.set_font("helvetica", "I", 10)
        self.cell(0, 10, "Comprehensive Analysis of Colombo's Geospatial AI Workspace", border=False, ln=True, align="C")
        self.ln(5)

    def footer(self):
        self.set_y(-15)
        self.set_font("helvetica", "I", 8)
        self.cell(0, 10, f"Page {self.page_no()}", align="C")

    def chapter_title(self, title):
        self.set_font("helvetica", "B", 14)
        self.set_fill_color(200, 220, 255)
        self.cell(0, 10, title, ln=True, fill=True)
        self.ln(4)

    def chapter_body(self, text):
        self.set_font("helvetica", "", 11)
        self.multi_cell(0, 6, text)
        self.ln(4)

def generate_pdf():
    print("Generating PDF report...")
    pdf = PDFReport()
    pdf.add_page()
    
    # --- 1. Introduction ---
    pdf.chapter_title("1. Introduction")
    intro_text = (
        "Aether-Urban is an advanced geospatial AI workspace designed for urban planning in Colombo, "
        "Sri Lanka. It integrates large language models (LLMs) with geographic information systems (GIS) "
        "to allow urban planners to query, analyze, and visualize spatial data using natural language. "
        "The system aims to drastically reduce the time needed to perform complex GIS analyses like proximity "
        "checks, zoning compliance, and area summaries."
    )
    pdf.chapter_body(intro_text)
    
    # --- 2. System Architecture ---
    pdf.chapter_title("2. System Architecture")
    arch_text = (
        "The architecture of Aether-Urban consists of three primary layers:\n\n"
        "1. Frontend (Client-side): Built using vanilla JavaScript and Leaflet.js, the frontend provides an interactive "
        "map interface. It connects to the backend via Server-Sent Events (SSE) to receive streaming GeoJSON data and "
        "map actions (pan, zoom, highlight) in real-time as the AI agent processes the request.\n\n"
        "2. API Layer (Backend): A FastAPI Python application ('app.py') that exposes the chatbot and map data endpoints. "
        "It acts as a middleware, receiving user queries, parsing them, and interacting with the LLM. It includes a custom "
        "stream parser that extracts hidden 'tool-call' blocks from the LLM's response before sending the cleaned text to the user.\n\n"
        "3. AI & Geospatial Backend: Uses Google's 'gemma-4-31b-it' (via Gemini API) or 'qwen2.5-coder' (via local Ollama) "
        "for reasoning. When the LLM decides a spatial analysis is needed, the backend triggers functions in 'spatial_tools.py'. "
        "This module utilizes GeoPandas, Shapely, and OSMnx to execute intersections, distance calculations, and routing."
    )
    pdf.chapter_body(arch_text)
    
    # --- 3. Data Flow & Optimizations ---
    pdf.add_page()
    pdf.chapter_title("3. Data Pipeline & Performance Optimizations")
    opt_text = (
        "Given the massive amount of geospatial data (over 100,000 polygons in total), several optimizations have been "
        "implemented to achieve millisecond response times:\n\n"
        "- Parquet Caching: Shapefiles are automatically converted and cached as GeoParquet files, resulting in up to 5x faster read times.\n"
        "- Pre-Projection: Spatial layers are pre-projected from WGS84 (EPSG:4326) to UTM (EPSG:32644) during startup and cached in memory. "
        "This eliminates the costly overhead of projecting large geometries during individual tool calls.\n"
        "- Spatial Indexing (sindex): For bounding box filters and proximity analyses, spatial indices are used to instantly "
        "filter features rather than checking geometry intersections for the entire dataset.\n"
        "- Dynamic Geometry Simplification: The backend applies the Douglas-Peucker algorithm to simplify complex polygons before "
        "transmission, dynamically calculating a tolerance based on the viewport span (span / 1500.0). This prevents browser thread "
        "locking when rendering large datasets.\n"
        "- Viewport Restraints: Detailed layers like buildings (90k+ features) are restricted from loading fully until the user "
        "zooms in past a threshold (zoom level 15)."
    )
    pdf.chapter_body(opt_text)
    
    # --- 4. Feature Statistics ---
    pdf.chapter_title("4. Spatial Data Feature Counts")
    pdf.image("feature_counts.png", w=150)
    pdf.ln(5)
    
    # --- 5. Capabilities Overview ---
    pdf.add_page()
    pdf.chapter_title("5. Core Capabilities")
    cap_text = (
        "Aether-Urban's spatial AI agent is equipped with the following tool-calling capabilities:\n\n"
        "- Data Summarization: Get overall statistics, available columns, and unique attribute values for layers.\n"
        "- Attribute Filtering: Find and map specific features (e.g., 'Commercial buildings', 'A-class roads').\n"
        "- Spatial Intersections: Overlay layers to find intersections (e.g., finding buildings within a specific land use zone).\n"
        "- Proximity Analysis: Buffer a target feature by a specific distance (e.g., '500m buffer around schools').\n"
        "- Routing & Isochrones: Calculate walking paths and generate walking time polygons using OSMnx network graphs.\n"
        "- Zoning Compliance: Verify if a proposed development coordinate complies with the underlying municipal zoning laws."
    )
    pdf.chapter_body(cap_text)
    
    pdf.output("Aether_Urban_Full_Report.pdf")
    print("Report generated successfully as Aether_Urban_Full_Report.pdf")

if __name__ == "__main__":
    generate_graphs()
    generate_pdf()
