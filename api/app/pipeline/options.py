from dataclasses import dataclass
import os

@dataclass
class PipelineOptions:
    target_long_side_px: int = 12000
    dpi: int = 600
    pad_frac: float = 0.01
    detector_spacing_m: float = 5.0
    wall_buffer_m: float = 0.5
    gemini_model: str = "gemini-3.1-flash-image-preview"
    use_gemini: bool = False
    world_to_m: float = 0.001  # DXF units -> meters (default mm)

    @staticmethod
    def from_env() -> "PipelineOptions":
        return PipelineOptions(
            target_long_side_px=int(os.getenv("TARGET_LONG_SIDE_PX", "12000")),
            dpi=int(os.getenv("DPI", "600")),
            pad_frac=float(os.getenv("PAD_FRAC", "0.01")),
            detector_spacing_m=float(os.getenv("DETECTOR_SPACING_M", "5.0")),
            wall_buffer_m=float(os.getenv("WALL_BUFFER_M", "0.5")),
            gemini_model=os.getenv("GEMINI_IMAGE_MODEL", "gemini-3.1-flash-image-preview"),
            use_gemini=bool(os.getenv("GEMINI_API_KEY", "").strip()),
            world_to_m=float(os.getenv("WORLD_TO_M", "0.001")),
        )

    def merge_settings(self, settings: dict) -> "PipelineOptions":
        # Allow UI to override these
        if "detector_spacing_m" in settings:
            self.detector_spacing_m = float(settings["detector_spacing_m"])
        if "wall_buffer_m" in settings:
            self.wall_buffer_m = float(settings["wall_buffer_m"])
        if "target_long_side_px" in settings:
            self.target_long_side_px = int(settings["target_long_side_px"])
        if "gemini_model" in settings:
            self.gemini_model = str(settings["gemini_model"])

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
