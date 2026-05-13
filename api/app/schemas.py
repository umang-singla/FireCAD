from pydantic import BaseModel
from typing import Optional, Any, Dict, List

class ProjectCreate(BaseModel):
    name: str

class ProjectUpdateSettings(BaseModel):
    settings: Dict[str, Any]

class ProjectOut(BaseModel):
    id: str
    name: str
    status: str
    error: Optional[str] = None
    files: Dict[str, Optional[str]] = {}
    nbc_evaluation: Optional[Dict[str, Any]] = None
    nbc_answers: Optional[Dict[str, Any]] = None
    settings: Optional[Dict[str, Any]] = None
    input_filename: Optional[str] = None
    floor_plans_count: int = 0

class DetectorOut(BaseModel):
    id: str
    project_id: str
    x: float
    y: float
    z: float = 0.0
    rotation_deg: float = 0.0
    dtype: str = "smoke"
    locked: bool = False
    floor_plan_id: Optional[str] = None

class DetectorCreate(BaseModel):
    x: float
    y: float
    z: float = 0.0
    rotation_deg: float = 0.0
    dtype: str = "smoke"
    floor_plan_id: Optional[str] = None

class DetectorUpdate(BaseModel):
    x: float
    y: float
    z: float = 0.0
    rotation_deg: Optional[float] = None
    dtype: Optional[str] = None
    locked: Optional[bool] = None


# ── BOQ ──────────────────────────────────────────────────────────────

class BOQItemCreate(BaseModel):
    section: str = "21 — Fire Suppression"
    item_type: str = "Material"
    description: str
    qty: float = 1.0
    unit: str = "unit"
    unit_price: float = 0.0
    notes: Optional[str] = None
    sort_order: int = 0

class BOQItemUpdate(BaseModel):
    section: Optional[str] = None
    item_type: Optional[str] = None
    description: Optional[str] = None
    qty: Optional[float] = None
    unit: Optional[str] = None
    unit_price: Optional[float] = None
    notes: Optional[str] = None
    sort_order: Optional[int] = None

class BOQItemOut(BaseModel):
    id: str
    project_id: str
    section: str
    item_type: str
    description: str
    qty: float
    unit: str
    unit_price: float
    notes: Optional[str] = None
    sort_order: int

class BOQMetaUpdate(BaseModel):
    client_name: Optional[str] = None
    quote_title: Optional[str] = None
    quote_number: Optional[str] = None
    valid_from: Optional[str] = None
    valid_until: Optional[str] = None
    version: Optional[int] = None
    scope_notes: Optional[str] = None

class BOQMetaOut(BaseModel):
    project_id: str
    client_name: Optional[str] = None
    quote_title: Optional[str] = None
    quote_number: Optional[str] = None
    valid_from: Optional[str] = None
    valid_until: Optional[str] = None
    version: int = 1
    scope_notes: Optional[str] = None

class BOQBulkSave(BaseModel):
    meta: Optional[BOQMetaUpdate] = None
    items: List[BOQItemCreate] = []
