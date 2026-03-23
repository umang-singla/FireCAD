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
    input_filename: Optional[str] = None

class DetectorOut(BaseModel):
    id: str
    project_id: str
    x: float
    y: float
    z: float = 0.0
    dtype: str = "smoke"
    locked: bool = False

class DetectorCreate(BaseModel):
    x: float
    y: float
    z: float = 0.0
    dtype: str = "smoke"

class DetectorUpdate(BaseModel):
    x: float
    y: float
    z: float = 0.0
    dtype: Optional[str] = None
    locked: Optional[bool] = None
