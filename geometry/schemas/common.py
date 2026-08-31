"""Pydantic models for common format conversions (B3DM/glTF to OBJ)."""

from typing import List

from pydantic import BaseModel


class ConvertRequest(BaseModel):
    input_path: str
    output_path: str


class ConvertResponse(BaseModel):
    success: bool
    message: str
    output_path: str | None = None


class BatchConvertItem(BaseModel):
    input_path: str
    output_path: str


class BatchConvertRequest(BaseModel):
    items: List[BatchConvertItem]


class BatchConvertResponse(BaseModel):
    success: bool
    message: str
    output_paths: List[str] = []
    failed_items: List[dict] = []
