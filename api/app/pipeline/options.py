from dataclasses import dataclass
import os

# Single source of truth for detector / geometry defaults.
# Change DETECTOR_SPACING_M in place_detectors_advanced.py and it propagates here.
from app.pipeline.place_detectors_advanced import (
    DETECTOR_SPACING_M as _DEFAULT_DETECTOR_SPACING_M,
    WALL_BUFFER_M as _DEFAULT_WALL_BUFFER_M,
    WORLD_TO_M as _DEFAULT_WORLD_TO_M,
)

@dataclass
class PipelineOptions:
    target_long_side_px: int = 6000
    dpi: int = 600
    pad_frac: float = 0.01
    detector_spacing_m: float = _DEFAULT_DETECTOR_SPACING_M
    wall_buffer_m: float = _DEFAULT_WALL_BUFFER_M
    gemini_model: str = "gemini-3.1-flash-image-preview"
    use_gemini: bool = False
    world_to_m: float = _DEFAULT_WORLD_TO_M  # DXF units -> meters (default mm)

    # Sprinkler settings
    sprinkler_spacing_m: float = 3.0
    enable_sprinklers: bool = True
    sprinkler_source_labels: list | None = None   # DXF text/block labels for pipe source detection

    # Room filtering
    room_exclude_keywords: list | None = None      # DXF text labels to exclude rooms (e.g. toilets)

    @staticmethod
    def from_env() -> "PipelineOptions":
        return PipelineOptions(
            target_long_side_px=int(os.getenv("TARGET_LONG_SIDE_PX", "6000")),
            dpi=int(os.getenv("DPI", "600")),
            pad_frac=float(os.getenv("PAD_FRAC", "0.01")),
            detector_spacing_m=float(os.getenv("DETECTOR_SPACING_M", str(_DEFAULT_DETECTOR_SPACING_M))),
            wall_buffer_m=float(os.getenv("WALL_BUFFER_M", str(_DEFAULT_WALL_BUFFER_M))),
            gemini_model=os.getenv("GEMINI_IMAGE_MODEL", "gemini-3.1-flash-image-preview"),
            use_gemini=bool(os.getenv("GEMINI_API_KEY", "").strip()),
            world_to_m=float(os.getenv("WORLD_TO_M", str(_DEFAULT_WORLD_TO_M))),
            sprinkler_spacing_m=float(os.getenv("SPRINKLER_SPACING_M", "3.0")),
            enable_sprinklers=os.getenv("ENABLE_SPRINKLERS", "0").strip().lower() in ("1", "true", "yes"),
        )

    def merge_settings(self, settings: dict) -> "PipelineOptions":
        # Backend-owned constants (detector_spacing_m, wall_buffer_m) are
        # intentionally NOT overridable from the UI. They are defined in
        # app.pipeline.place_detectors_advanced and propagated through this
        # dataclass / env vars only. Any value the UI sends for them is ignored.
        if "target_long_side_px" in settings:
            self.target_long_side_px = int(settings["target_long_side_px"])
        if "gemini_model" in settings:
            self.gemini_model = str(settings["gemini_model"])

        # Sprinkler overrides
        if "sprinkler_spacing_m" in settings:
            self.sprinkler_spacing_m = float(settings["sprinkler_spacing_m"])
        if "enable_sprinklers" in settings:
            val = settings["enable_sprinklers"]
            self.enable_sprinklers = val if isinstance(val, bool) else str(val).lower() in ("1", "true", "yes")
        if "sprinkler_source_labels" in settings:
            self.sprinkler_source_labels = list(settings["sprinkler_source_labels"])
        if "room_exclude_keywords" in settings:
            self.room_exclude_keywords = list(settings["room_exclude_keywords"])

        # Units overrides
        if "world_to_m" in settings:
            self.world_to_m = float(settings["world_to_m"])
        if "units" in settings:
            u = str(settings["units"]).lower().strip()
            unit_map = {
                "mm": 0.001, "millimeter": 0.001, "millimetre": 0.001,
                "cm": 0.01, "centimeter": 0.01, "centimetre": 0.01,
                "m": 1.0, "meter": 1.0, "metre": 1.0,
                "inch": 0.0254, "in": 0.0254,
                "ft": 0.3048, "feet": 0.3048, "foot": 0.3048,
            }
            if u in unit_map:
                self.world_to_m = unit_map[u]

        return self
