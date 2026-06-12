import geopandas as gpd
import pandas as pd
import numpy as np
from shapely.geometry import Point, mapping
from shapely.ops import unary_union
import osmnx as ox
import networkx as nx
import json
import os
import traceback

# Try local data directory first, fallback to parent directory structure if not found
local_data_dir = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"))
if os.path.exists(local_data_dir):
    DATA_DIR = local_data_dir
else:
    DATA_DIR = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "Model", "Data", "Data"))
SRC_CRS = "EPSG:4326"
PROJ_CRS = "EPSG:32644"

_cache = {}

LAYER_MAP = {
    "building": "Building.shp",
    "land_use": "Land Use.shp",
    "zoning": "Zoning.shp",
    "road": "Road.shp",
}

MAX_GEOJSON_FEATURES = 200000

# Colombo bounding box for coordinate validation
_COLOMBO_BOUNDS = {"min_lat": 6.0, "max_lat": 8.0, "min_lon": 79.0, "max_lon": 81.0}

ACTIVE_STUDY_AREA = None


def _validate_layer_name(name):
    key = name.lower().strip() if isinstance(name, str) else ""
    if key not in LAYER_MAP:
        raise ValueError(f"Unknown layer: {name}. Available: {list(LAYER_MAP.keys())}")
    return key


def _validate_coords(lat, lon):
    lat, lon = float(lat), float(lon)
    if not (_COLOMBO_BOUNDS["min_lat"] <= lat <= _COLOMBO_BOUNDS["max_lat"]):
        raise ValueError(f"Latitude {lat} out of Colombo range ({_COLOMBO_BOUNDS['min_lat']}-{_COLOMBO_BOUNDS['max_lat']})")
    if not (_COLOMBO_BOUNDS["min_lon"] <= lon <= _COLOMBO_BOUNDS["max_lon"]):
        raise ValueError(f"Longitude {lon} out of Colombo range ({_COLOMBO_BOUNDS['min_lon']}-{_COLOMBO_BOUNDS['max_lon']})")
    return lat, lon


def _validate_column(gdf, column_name, layer_name):
    if column_name not in gdf.columns:
        available = [c for c in gdf.columns if c != "geometry"]
        raise ValueError(f"Column '{column_name}' not found in '{layer_name}'. Available: {available}")


_cache_proj = {}

def _cache_projection(key, gdf):
    gdf = gdf.reset_index(drop=True)
    try:
        gdf_proj = gdf.to_crs(PROJ_CRS)
        # Pre-build spatial index on projected data for instant queries
        _ = gdf_proj.sindex
        _cache_proj[key] = gdf_proj
        # Pre-calculate area once and store it in both dataframes
        gdf["_area_ha"] = gdf_proj.geometry.area / 10000.0
        gdf_proj["_area_ha"] = gdf["_area_ha"]
    except Exception as e:
        print(f"Failed to pre-project layer {key}: {e}")
        gdf["_area_ha"] = 0.0
    # Pre-build spatial index on geographic data too
    _ = gdf.sindex
    _cache[key] = gdf
    return gdf


def _load_layer(name):
    key = name.lower().strip()
    if key in _cache:
        return _cache[key]
    if key not in LAYER_MAP:
        raise ValueError(f"Unknown layer: {name}. Available: {list(LAYER_MAP.keys())}")
    
    # Try loading GeoParquet format first for 5x speedup
    parquet_filename = LAYER_MAP[key].replace(".shp", ".parquet")
    parquet_path = os.path.join(DATA_DIR, parquet_filename)
    if os.path.exists(parquet_path):
        try:
            gdf = gpd.read_parquet(parquet_path)
            if gdf.crs is None:
                gdf = gdf.set_crs(SRC_CRS)
            elif gdf.crs.to_epsg() != 4326:
                gdf = gdf.to_crs(SRC_CRS)
            return _cache_projection(key, gdf)
        except Exception as e:
            print(f"Error loading parquet {parquet_path}: {e}. Deleting corrupt cache and falling back to shapefile.")
            try:
                os.remove(parquet_path)
            except OSError:
                pass

    path = os.path.join(DATA_DIR, LAYER_MAP[key])
    if not os.path.exists(path):
        raise FileNotFoundError(f"Shapefile not found: {path}")
    gdf = gpd.read_file(path)
    gdf = gdf[gdf.geometry.notnull()].copy()
    if gdf.crs is None:
        gdf = gdf.set_crs(SRC_CRS)
    elif gdf.crs.to_epsg() != 4326:
        gdf = gdf.to_crs(SRC_CRS)
    
    # Save as GeoParquet for subsequent lightning-fast reads
    try:
        gdf.to_parquet(parquet_path)
    except Exception as e:
        print(f"Failed to save parquet cache {parquet_path}: {e}")

    return _cache_projection(key, gdf)


def _get_active_layer(name):
    gdf = _load_layer(name)
    if ACTIVE_STUDY_AREA:
        return _filter_by_bbox(gdf, ACTIVE_STUDY_AREA)
    return gdf


def _to_projected(gdf):
    # Direct lookup using id() for O(1) cache retrieval instead of iterating
    for key, cached_gdf in _cache.items():
        if gdf is cached_gdf and key in _cache_proj:
            return _cache_proj[key]
    return gdf.to_crs(PROJ_CRS)


def _to_geographic(gdf):
    return gdf.to_crs(SRC_CRS)


def _safe_geojson(gdf, max_features=None):
    if gdf.crs and gdf.crs.to_epsg() != 4326:
        gdf = _to_geographic(gdf)
        
    if max_features is not None and len(gdf) > max_features:
        gdf = gdf.sample(n=max_features, random_state=42).copy()
        
    try:
        bounds = gdf.total_bounds
        span = max(bounds[2] - bounds[0], bounds[3] - bounds[1])
        # Use more aggressive simplification to maintain rendering speed for uncapped queries
        tolerance = span / 1500.0
        if tolerance > 0.000005:
            gdf_simplified = gdf.copy()
            simplified = gdf_simplified.geometry.simplify(tolerance, preserve_topology=False)
            empty_mask = simplified.is_empty
            final_geom = simplified.copy()
            if empty_mask.any():
                final_geom[empty_mask] = gdf_simplified.geometry[empty_mask].centroid
            gdf_simplified["geometry"] = final_geom
            gdf = gdf_simplified
    except Exception as e:
        print(f"Error simplifying in _safe_geojson: {e}")
        
    return json.loads(gdf.to_json())


def _safe_geojson_str(gdf, max_features=None):
    if gdf.crs and gdf.crs.to_epsg() != 4326:
        gdf = _to_geographic(gdf)
    if max_features is not None and len(gdf) > max_features:
        gdf = gdf.sample(n=max_features, random_state=42).copy()
    return gdf.to_json()


def _filter_by_bbox(gdf, bbox):
    if not bbox:
        return gdf
    try:
        if isinstance(bbox, str):
            parts = [float(x.strip()) for x in bbox.split(",")]
        else:
            parts = [float(x) for x in bbox]
        if len(parts) != 4:
            return gdf
        min_lon, min_lat, max_lon, max_lat = parts
        
        # Use spatial index to quickly filter features intersecting the bounding box.
        # Bypassing the exact geometry.intersects(bbox_geom) check on thousands of polygons
        # speeds up the lookup from ~4 seconds to ~5 milliseconds.
        possible_matches_index = list(gdf.sindex.intersection((min_lon, min_lat, max_lon, max_lat)))
        return gdf.iloc[possible_matches_index].copy()
    except Exception as e:
        print(f"Error filtering by bbox: {e}")
        return gdf


def _bounds_to_bbox(bounds):
    return [bounds[1], bounds[0], bounds[3], bounds[2]]


def _make_map_action(gdf, layer_name="result", filter_attr=None, filter_val=None):
    if gdf.crs and gdf.crs.to_epsg() != 4326:
        gdf_geo = _to_geographic(gdf)
    else:
        gdf_geo = gdf
    bounds = gdf_geo.total_bounds
    center_lon = (bounds[0] + bounds[2]) / 2
    center_lat = (bounds[1] + bounds[3]) / 2
    lat_span = bounds[3] - bounds[1]
    lon_span = bounds[2] - bounds[0]
    max_span = max(lat_span, lon_span)
    if max_span > 0.1:
        zoom = 12
    elif max_span > 0.05:
        zoom = 13
    elif max_span > 0.01:
        zoom = 14
    elif max_span > 0.005:
        zoom = 15
    elif max_span > 0.001:
        zoom = 16
    else:
        zoom = 17
    geojson = _safe_geojson(gdf_geo)
    highlight = {
        "layer": layer_name,
        "bounding_box": _bounds_to_bbox(bounds),
    }
    if filter_attr:
        highlight["filter_attribute"] = filter_attr
    if filter_val:
        highlight["filter_value"] = filter_val
    return {
        "map_action": "PAN_AND_ZOOM",
        "target_center": [center_lat, center_lon],
        "zoom_level": zoom,
        "highlight_geometries": highlight,
        "geojson": geojson,
    }


def get_layer_summary(layer_name: str) -> dict:
    try:
        gdf = _get_active_layer(layer_name)
        gdf_proj = _to_projected(gdf)
        cols = [c for c in gdf.columns if c != "geometry"]
        cat_cols = gdf[cols].select_dtypes(include=["object"]).columns.tolist()
        unique_vals = {}
        for c in cat_cols[:5]:
            vc = gdf[c].value_counts().head(20)
            unique_vals[c] = {str(k): int(v) for k, v in vc.items()}
        total_area_ha = None
        geom_types = gdf.geometry.geom_type.unique().tolist()
        if any(t in ["Polygon", "MultiPolygon"] for t in geom_types):
            total_area_ha = round(float(gdf_proj.geometry.area.sum() / 10000), 4)
        bounds = gdf.total_bounds.tolist()
        ma = _make_map_action(gdf, layer_name=layer_name)
        return {
            "status": "success",
            "message": f"Summary for layer '{layer_name}': {len(gdf)} features",
            "data": {
                "row_count": len(gdf),
                "columns": cols,
                "geometry_types": geom_types,
                "categorical_unique_values": unique_vals,
                "total_area_hectares": total_area_ha,
                "bounds": bounds,
            },
            "map_action": ma,
        }
    except Exception as e:
        return {"status": "error", "message": str(e), "data": traceback.format_exc()}


def get_layer_columns(layer_name: str) -> dict:
    try:
        gdf = _get_active_layer(layer_name)
        col_info = {c: str(gdf[c].dtype) for c in gdf.columns}
        return {
            "status": "success",
            "message": f"Columns for layer '{layer_name}'",
            "data": col_info,
        }
    except Exception as e:
        return {"status": "error", "message": str(e), "data": traceback.format_exc()}


def get_unique_values(layer_name: str, column_name: str) -> dict:
    try:
        gdf = _get_active_layer(layer_name)
        if column_name not in gdf.columns:
            return {
                "status": "error",
                "message": f"Column '{column_name}' not found. Available: {[c for c in gdf.columns if c != 'geometry']}",
                "data": None,
            }
        vc = gdf[column_name].value_counts(dropna=False)
        result = {str(k): int(v) for k, v in vc.items()}
        return {
            "status": "success",
            "message": f"Unique values for '{column_name}' in '{layer_name}': {len(result)} unique values",
            "data": result,
        }
    except Exception as e:
        return {"status": "error", "message": str(e), "data": traceback.format_exc()}


def filter_features(layer_name: str, attribute: str, value: str) -> dict:
    try:
        gdf = _get_active_layer(layer_name)
        if attribute not in gdf.columns:
            return {
                "status": "error",
                "message": f"Column '{attribute}' not found. Available: {[c for c in gdf.columns if c != 'geometry']}",
                "data": None,
            }
        mask = gdf[attribute].astype(str).str.contains(str(value), case=False, na=False)
        filtered = gdf[mask].copy()
        if filtered.empty:
            return {
                "status": "success",
                "message": f"No features found where '{attribute}' contains '{value}'",
                "data": {"count": 0},
            }
        area_stats = None
        geom_types = filtered.geometry.geom_type.unique().tolist()
        if any(t in ["Polygon", "MultiPolygon"] for t in geom_types):
            proj = _to_projected(filtered)
            areas_ha = proj.geometry.area / 10000
            area_stats = {
                "total_hectares": round(float(areas_ha.sum()), 4),
                "mean_hectares": round(float(areas_ha.mean()), 4),
                "min_hectares": round(float(areas_ha.min()), 6),
                "max_hectares": round(float(areas_ha.max()), 4),
            }
        sample_cols = [c for c in filtered.columns if c != "geometry"]
        sample = filtered[sample_cols].head(10).to_dict(orient="records")
        ma = _make_map_action(filtered, layer_name=layer_name, filter_attr=attribute, filter_val=value)
        return {
            "status": "success",
            "message": f"Found {len(filtered)} features where '{attribute}' contains '{value}'",
            "data": {
                "count": len(filtered),
                "area_stats": area_stats,
                "sample": sample,
            },
            "map_action": ma,
        }
    except Exception as e:
        return {"status": "error", "message": str(e), "data": traceback.format_exc()}


def calculate_area_by_category(layer_name: str, category_column: str) -> dict:
    try:
        gdf = _get_active_layer(layer_name)
        if category_column not in gdf.columns:
            return {
                "status": "error",
                "message": f"Column '{category_column}' not found.",
                "data": None,
            }
        proj = _to_projected(gdf)
        proj["_area_ha"] = proj.geometry.area / 10000
        grouped = proj.groupby(category_column)["_area_ha"].agg(["sum", "count"]).reset_index()
        grouped.columns = [category_column, "area_hectares", "feature_count"]
        grouped = grouped.sort_values("area_hectares", ascending=False).reset_index(drop=True)
        total = grouped["area_hectares"].sum()
        grouped["percentage"] = round(grouped["area_hectares"] / total * 100, 2)
        grouped["area_hectares"] = grouped["area_hectares"].round(4)
        breakdown = grouped.to_dict(orient="records")
        ma = _make_map_action(gdf, layer_name=layer_name)
        return {
            "status": "success",
            "message": f"Area breakdown by '{category_column}' in '{layer_name}': {len(breakdown)} categories, total {round(total, 2)} ha",
            "data": {
                "total_area_hectares": round(float(total), 4),
                "breakdown": breakdown,
            },
            "map_action": ma,
        }
    except Exception as e:
        return {"status": "error", "message": str(e), "data": traceback.format_exc()}


def proximity_analysis(layer_name: str, attribute: str, value: str, buffer_meters: float = 500) -> dict:
    try:
        gdf = _get_active_layer(layer_name)
        if attribute not in gdf.columns:
            return {
                "status": "error",
                "message": f"Column '{attribute}' not found.",
                "data": None,
            }
        mask = gdf[attribute].astype(str).str.contains(str(value), case=False, na=False)
        targets = gdf[mask].copy()
        if targets.empty:
            return {
                "status": "success",
                "message": f"No features found where '{attribute}' contains '{value}'",
                "data": {"count": 0},
            }
        targets_proj = _to_projected(targets)
        buffer_union = unary_union(targets_proj.geometry.buffer(buffer_meters))
        gdf_proj = _to_projected(gdf)
        non_target = gdf_proj[~mask].copy()
        
        # Optimize with spatial index bbox filter to speed up intersection test
        possible_matches_index = list(non_target.sindex.intersection(buffer_union.bounds))
        possible_matches = non_target.iloc[possible_matches_index]
        within_mask = possible_matches.geometry.intersects(buffer_union)
        affected = possible_matches[within_mask].copy()
        
        buffer_gdf = gpd.GeoDataFrame(geometry=[buffer_union], crs=PROJ_CRS)
        buffer_geo = _to_geographic(buffer_gdf)
        buffer_geojson = json.loads(buffer_geo.to_json())
        affected_geo = _to_geographic(affected) if not affected.empty else affected
        combined = pd.concat([_to_geographic(targets), affected_geo]) if not affected.empty else _to_geographic(targets)
        ma = _make_map_action(combined, layer_name=layer_name, filter_attr=attribute, filter_val=value)
        ma["geojson"] = buffer_geojson
        sample_cols = [c for c in affected.columns if c != "geometry"]
        sample = _to_geographic(affected)[sample_cols].head(10).to_dict(orient="records") if not affected.empty else []
        return {
            "status": "success",
            "message": f"Proximity analysis: {len(targets)} target features, {len(affected)} features within {buffer_meters}m buffer",
            "data": {
                "target_count": len(targets),
                "buffer_meters": buffer_meters,
                "affected_count": len(affected),
                "affected_sample": sample,
                "buffer_geojson": buffer_geojson,
            },
            "map_action": ma,
        }
    except Exception as e:
        return {"status": "error", "message": str(e), "data": traceback.format_exc()}


def spatial_intersection(layer1_name: str, layer2_name: str, filter_attr: str = None, filter_val: str = None) -> dict:
    try:
        gdf1 = _get_active_layer(layer1_name)
        gdf2 = _get_active_layer(layer2_name)
        if filter_attr and filter_val:
            if filter_attr not in gdf1.columns:
                return {
                    "status": "error",
                    "message": f"Column '{filter_attr}' not found in '{layer1_name}'.",
                    "data": None,
                }
            mask = gdf1[filter_attr].astype(str).str.contains(str(filter_val), case=False, na=False)
            gdf1 = gdf1[mask].copy()
            if gdf1.empty:
                return {
                    "status": "success",
                    "message": f"No features in '{layer1_name}' match filter.",
                    "data": {"count": 0},
                }
        gdf1_proj = _to_projected(gdf1)
        gdf2_proj = _to_projected(gdf2)
        intersection = gpd.overlay(gdf1_proj, gdf2_proj, how="intersection")
        if intersection.empty:
            return {
                "status": "success",
                "message": "No spatial intersection found between the layers.",
                "data": {"count": 0},
            }
        geom_types = intersection.geometry.geom_type.unique().tolist()
        area_info = None
        if any(t in ["Polygon", "MultiPolygon"] for t in geom_types):
            intersection["_area_ha"] = intersection.geometry.area / 10000
            area_info = {
                "total_hectares": round(float(intersection["_area_ha"].sum()), 4),
                "mean_hectares": round(float(intersection["_area_ha"].mean()), 6),
            }
        intersection_geo = _to_geographic(intersection)
        sample_cols = [c for c in intersection_geo.columns if c not in ["geometry", "_area_ha"]]
        sample = intersection_geo[sample_cols].head(10).to_dict(orient="records")
        ma = _make_map_action(intersection_geo, layer_name=f"{layer1_name}_x_{layer2_name}")
        return {
            "status": "success",
            "message": f"Intersection of '{layer1_name}' and '{layer2_name}': {len(intersection)} features",
            "data": {
                "count": len(intersection),
                "area_stats": area_info,
                "sample": sample,
            },
            "map_action": ma,
        }
    except Exception as e:
        return {"status": "error", "message": str(e), "data": traceback.format_exc()}





_walk_graph = None
_walk_graph_proj = None

def _load_walk_graph():
    global _walk_graph, _walk_graph_proj
    if _walk_graph_proj is not None:
        return _walk_graph, _walk_graph_proj
    
    graph_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "colombo_walk.graphml")
    if os.path.exists(graph_path):
        try:
            _walk_graph = ox.load_graphml(graph_path)
            _walk_graph_proj = ox.projection.project_graph(_walk_graph)
            return _walk_graph, _walk_graph_proj
        except Exception:
            pass
            
    try:
        north, south, east, west = 6.99, 6.85, 79.90, 79.83
        G = ox.graph_from_bbox((west, south, east, north), network_type="walk")
        ox.save_graphml(G, filepath=graph_path)
        _walk_graph = G
        _walk_graph_proj = ox.projection.project_graph(G)
        return _walk_graph, _walk_graph_proj
    except Exception as e:
        raise RuntimeError(f"Failed to load walking graph: {str(e)}")


def nearest_features(layer_name: str, lat: float, lon: float, n: int = 5) -> dict:
    try:
        from pyproj import Transformer
        gdf = _get_active_layer(layer_name)
        gdf_proj = _to_projected(gdf)

        # Project point directly with Transformer — avoids creating a GeoDataFrame
        transformer = Transformer.from_crs(SRC_CRS, PROJ_CRS, always_xy=True)
        px, py = transformer.transform(lon, lat)
        projected_point = Point(px, py)

        # Optimize with spatial index bbox filter to limit distance calculations
        bbox = (px - 2000, py - 2000, px + 2000, py + 2000)
        possible_matches_index = list(gdf_proj.sindex.intersection(bbox))
        if len(possible_matches_index) >= n:
            candidates = gdf_proj.iloc[possible_matches_index].copy()
        else:
            candidates = gdf_proj

        candidates["_distance_m"] = candidates.geometry.distance(projected_point)
        nearest = candidates.nsmallest(n, "_distance_m").copy()
        nearest_geo = _to_geographic(nearest)

        # Vectorized result building instead of slow iterrows()
        cols = [c for c in nearest_geo.columns if c not in ["geometry", "_distance_m"]]
        results = nearest_geo[cols].to_dict(orient="records")
        distances = nearest["_distance_m"].round(2).tolist()
        centroids_y = nearest_geo.geometry.centroid.y.round(6).tolist()
        centroids_x = nearest_geo.geometry.centroid.x.round(6).tolist()
        geom_types = nearest_geo.geometry.geom_type.tolist()
        for i, rec in enumerate(results):
            rec["distance_meters"] = float(distances[i])
            if geom_types[i] in ["Polygon", "MultiPolygon"]:
                rec["centroid_lat"] = float(centroids_y[i])
                rec["centroid_lon"] = float(centroids_x[i])

        ma = _make_map_action(nearest_geo, layer_name=layer_name)
        return {
            "status": "success",
            "message": f"Found {len(results)} nearest features in '{layer_name}' to ({lat}, {lon})",
            "data": {
                "query_point": {"lat": lat, "lon": lon},
                "nearest": results,
            },
            "map_action": ma,
        }
    except Exception as e:
        return {"status": "error", "message": str(e), "data": traceback.format_exc()}


def get_network_isochrone(lat: float, lon: float, walk_time_minutes: int = 10) -> dict:
    try:
        walk_speed_kmh = 4.5
        walk_speed_ms = walk_speed_kmh * 1000 / 3600
        dist_m = walk_speed_ms * walk_time_minutes * 60
        
        G, G_proj = _load_walk_graph()
        center_node = ox.distance.nearest_nodes(G, lon, lat)
        
        # Calculate routing edge times in UTM space
        for u, v, data in G_proj.edges(data=True):
            data["time"] = data.get("length", 0) / walk_speed_ms
            
        subgraph_nodes = nx.single_source_dijkstra_path_length(G_proj, center_node, cutoff=walk_time_minutes * 60, weight="time")
        node_points = [Point(G_proj.nodes[n]["x"], G_proj.nodes[n]["y"]) for n in subgraph_nodes]
        if len(node_points) < 3:
            return {
                "status": "success",
                "message": "Too few reachable nodes to form an isochrone.",
                "data": None,
            }
        iso_polygon = unary_union(node_points).convex_hull.buffer(50)
        iso_gdf = gpd.GeoDataFrame(geometry=[iso_polygon], crs=G_proj.graph.get("crs", PROJ_CRS))
        iso_geo = _to_geographic(iso_gdf)
        geojson = json.loads(iso_geo.to_json())
        bounds = iso_geo.total_bounds
        ma = {
            "map_action": "PAN_AND_ZOOM",
            "target_center": [lat, lon],
            "zoom_level": 15,
            "highlight_geometries": {
                "layer": "isochrone",
                "bounding_box": _bounds_to_bbox(bounds),
            },
            "geojson": geojson,
        }
        return {
            "status": "success",
            "message": f"{walk_time_minutes}-minute walking isochrone from ({lat}, {lon})",
            "data": {
                "center": {"lat": lat, "lon": lon},
                "walk_time_minutes": walk_time_minutes,
                "walk_speed_kmh": walk_speed_kmh,
                "coverage_distance_m": round(dist_m, 1),
                "reachable_nodes": len(subgraph_nodes),
                "isochrone_geojson": geojson,
            },
            "map_action": ma,
        }
    except Exception as e:
        return {"status": "error", "message": str(e), "data": traceback.format_exc()}


def get_walking_route(start_lat: float, start_lon: float, end_lat: float, end_lon: float) -> dict:
    try:
        mid_lat = (start_lat + end_lat) / 2
        mid_lon = (start_lon + end_lon) / 2
        
        G, G_proj = _load_walk_graph()
        orig_node = ox.distance.nearest_nodes(G, start_lon, start_lat)
        dest_node = ox.distance.nearest_nodes(G, end_lon, end_lat)
        
        route = nx.shortest_path(G_proj, orig_node, dest_node, weight="length")
        
        # Extract geographic coordinates for GeoJSON geometry mapping
        route_coords = [(G.nodes[n]["x"], G.nodes[n]["y"]) for n in route]
        from shapely.geometry import LineString
        route_geom = LineString(route_coords)
        route_gdf = gpd.GeoDataFrame(geometry=[route_geom], crs=SRC_CRS)
        route_proj = _to_projected(route_gdf)
        total_distance_m = float(route_proj.geometry.length.iloc[0])
        walk_speed_kmh = 4.5
        walk_time_min = total_distance_m / (walk_speed_kmh * 1000 / 60)
        geojson = json.loads(route_gdf.to_json())
        bounds = route_gdf.total_bounds
        ma = {
            "map_action": "PAN_AND_ZOOM",
            "target_center": [mid_lat, mid_lon],
            "zoom_level": 15,
            "highlight_geometries": {
                "layer": "route",
                "bounding_box": _bounds_to_bbox(bounds),
            },
            "geojson": geojson,
        }
        return {
            "status": "success",
            "message": f"Walking route: {round(total_distance_m)} m, ~{round(walk_time_min, 1)} min",
            "data": {
                "start": {"lat": start_lat, "lon": start_lon},
                "end": {"lat": end_lat, "lon": end_lon},
                "distance_meters": round(total_distance_m, 1),
                "estimated_walk_time_minutes": round(walk_time_min, 1),
                "route_nodes": len(route),
                "route_geojson": geojson,
            },
            "map_action": ma,
        }
    except nx.NetworkXNoPath:
        return {
            "status": "error",
            "message": "No walking path found between the given points.",
            "data": None,
        }
    except Exception as e:
        return {"status": "error", "message": str(e), "data": traceback.format_exc()}


def zoning_compliance_check(lat: float, lon: float, proposed_use: str) -> dict:
    try:
        zoning = _get_active_layer("zoning")
        point = Point(lon, lat)
        point_gdf = gpd.GeoDataFrame(geometry=[point], crs=SRC_CRS)
        joined = gpd.sjoin(point_gdf, zoning, how="left", predicate="within")
        if joined["index_right"].isna().all():
            return {
                "status": "success",
                "message": f"Point ({lat}, {lon}) does not fall within any zoning area.",
                "data": {
                    "point": {"lat": lat, "lon": lon},
                    "zone": None,
                    "proposed_use": proposed_use,
                    "compliance": "UNKNOWN",
                    "reason": "Point is outside all zoning boundaries.",
                },
            }
        zone_info = joined.iloc[0]
        zone_name = str(zone_info.get("zone", "Unknown"))
        compliance_map = {
            "residential": ["residential", "primary residential", "mixed residential"],
            "commercial": ["commercial", "mixed commercial", "activity center"],
            "industrial": ["industrial", "light industrial", "heavy industrial"],
            "institutional": ["institutional", "public & semi-public"],
            "recreational": ["recreational", "open space", "parks"],
            "mixed": ["mixed use", "mixed residential", "mixed commercial", "activity center"],
        }
        proposed_lower = proposed_use.lower()
        zone_lower = zone_name.lower()
        is_compliant = False
        matching_categories = []
        for category, keywords in compliance_map.items():
            if any(kw in proposed_lower for kw in [category]):
                matching_categories.append(category)
            if any(kw in zone_lower for kw in keywords):
                if any(kw in proposed_lower for kw in [category]) or category in proposed_lower:
                    is_compliant = True
        if not matching_categories:
            compliance_status = "REVIEW_REQUIRED"
            reason = f"Proposed use '{proposed_use}' could not be automatically categorized. Manual review needed for zone '{zone_name}'."
        elif is_compliant:
            compliance_status = "LIKELY_COMPLIANT"
            reason = f"Proposed use '{proposed_use}' appears compatible with zone '{zone_name}'."
        else:
            compliance_status = "LIKELY_NON_COMPLIANT"
            reason = f"Proposed use '{proposed_use}' may not be compatible with zone '{zone_name}'. Verify with local planning authority."
        zone_gdf = zoning[zoning["zone"] == zone_name].copy()
        ma = _make_map_action(zone_gdf if not zone_gdf.empty else point_gdf, layer_name="zoning", filter_attr="zone", filter_val=zone_name)
        return {
            "status": "success",
            "message": f"Zoning check at ({lat}, {lon}): Zone='{zone_name}', Compliance='{compliance_status}'",
            "data": {
                "point": {"lat": lat, "lon": lon},
                "zone": zone_name,
                "proposed_use": proposed_use,
                "compliance": compliance_status,
                "reason": reason,
            },
            "map_action": ma,
        }
    except Exception as e:
        return {"status": "error", "message": str(e), "data": traceback.format_exc()}


def get_overview() -> dict:
    try:
        overview = {}
        all_bounds = []
        for name in LAYER_MAP:
            try:
                gdf = _get_active_layer(name)
                bounds = gdf.total_bounds.tolist()
                all_bounds.append(bounds)
                overview[name] = {
                    "filename": LAYER_MAP[name],
                    "feature_count": len(gdf),
                    "columns": [c for c in gdf.columns if c != "geometry"],
                    "geometry_types": gdf.geometry.geom_type.unique().tolist(),
                    "bounds": bounds,
                }
            except Exception as layer_err:
                overview[name] = {"error": str(layer_err)}
        if all_bounds:
            all_bounds_arr = np.array(all_bounds)
            global_bounds = [
                float(all_bounds_arr[:, 0].min()),
                float(all_bounds_arr[:, 1].min()),
                float(all_bounds_arr[:, 2].max()),
                float(all_bounds_arr[:, 3].max()),
            ]
            center_lon = (global_bounds[0] + global_bounds[2]) / 2
            center_lat = (global_bounds[1] + global_bounds[3]) / 2
        else:
            global_bounds = []
            center_lat, center_lon = 6.9271, 79.8612
        ma = {
            "map_action": "PAN_AND_ZOOM",
            "target_center": [center_lat, center_lon],
            "zoom_level": 20,
            "highlight_geometries": {
                "layer": "overview",
                "bounding_box": _bounds_to_bbox(global_bounds) if global_bounds else [],
            },
            "geojson": None,
        }
        return {
            "status": "success",
            "message": f"Overview: {len(overview)} layers available",
            "data": {
                "layers": overview,
                "layers_list": [{"name": k, "count": v.get("feature_count", 0)} for k, v in overview.items() if "error" not in v],
                "center": [center_lat, center_lon],
                "global_bounds": global_bounds,
            },
            "map_action": ma,
        }
    except Exception as e:
        return {"status": "error", "message": str(e), "data": traceback.format_exc()}
