"""Building patch alignment request/response models."""

from typing import Any, Dict, List

from pydantic import BaseModel, Field


class AlignmentMeshTriangle(BaseModel):
    tileId: str | None = None
    faceIndex: int | None = None
    local: List[List[float]] | None = None
    geo: List[List[float]]


class AlignmentPatchMember(BaseModel):
    fullId: str
    osmType: str
    geometry: Dict[str, Any]
    osmHeight: str | None = None
    osmBuildingLevels: str | None = None
    attachmentGroupIndex: int | None = None
    attachmentGroupId: str | None = None
    attachmentGroupSize: int | None = None
    attachedMemberIds: List[str] = Field(default_factory=list)


class AlignmentPatchGroupTreeNode(BaseModel):
    groupIndex: int
    groupId: str
    parentGroupIndex: int | None = None
    parentGroupId: str | None = None
    childGroupIndices: List[int] = Field(default_factory=list)
    childGroupIds: List[str] = Field(default_factory=list)
    treeLevel: int = 1


class AlignmentPatchRequestItem(BaseModel):
    patchId: str
    geometry: Dict[str, Any]
    bufferedGeometry: Dict[str, Any] | None = None
    groundZ: float | None = None
    meshTriangleCountBeforeGroundFilter: int | None = None
    meshTriangleCountAfterGroundFilter: int | None = None
    groundFilteredTriangleCount: int | None = None
    attachmentGroupTree: List[AlignmentPatchGroupTreeNode] = Field(default_factory=list)
    members: List[AlignmentPatchMember] = Field(default_factory=list)
    meshTriangles: List[AlignmentMeshTriangle] = Field(default_factory=list)


class BuildingAlignmentRequest(BaseModel):
    patches: List[AlignmentPatchRequestItem] = Field(default_factory=list)
    patchInputPaths: List[str] = Field(default_factory=list)
    buildingOutputDir: str | None = None
