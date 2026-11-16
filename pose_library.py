"""Local, versioned pose catalog. Remote sources are read only on explicit refresh."""
import base64
import copy
from datetime import datetime, timezone
import hashlib
import io
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import struct
import tempfile
import threading
import urllib.parse
import urllib.request
import zipfile

from PIL import Image


ROOT = Path(__file__).resolve().parent
LOCK = threading.RLock()
TOKEN = re.compile(r"[a-f0-9]{64}\Z")
MAX_FILE = 2 * 1024 * 1024
MAX_PACK = 64 * 1024 * 1024
MAX_FILES = 2048
FORBIDDEN = {"__proto__", "prototype", "constructor"}
SOURCES = [
    {"id": "arekejoker", "name": "Curated Poses · Arekejoker", "repo": "Arekejoker/qwen21-nsfw-pose-skill", "host": "github", "license": "Third-party pose license unverified. Available for local import.", "prefix": "pose_library/", "ref": "b2690b8dd9ec479039967551dc38c77950b022fb"},
    {"id": "general", "name": "General Poses · Totemistyk", "repo": "Totemistyk/General_Poses_PoseStudio", "host": "huggingface", "license": "No upstream license declared", "ref": "23468b2be53ab91fe493754b241d27dcfeb965ed"},
    {"id": "ballet", "name": "Ballet · Totemistyk", "repo": "Totemistyk/Ballet_PoseStudio", "host": "huggingface", "license": "Upstream README declares the MIT license", "ref": "14d658f5891ac752126f47fabc54993a48980f23"},
    {"id": "miu-main", "name": "Main Pose Library · MIUProject", "repo": "MIUProject/VNCCS_PoseLibrary_Main", "host": "huggingface", "license": "No upstream license declared", "ref": "baef0455ef9d3cc31ce3e2a407f722069355c617"},
    {"id": "miu-super", "name": "Extended Poses · MIUProject", "repo": "MIUProject/MySuperPoseRepo", "host": "huggingface", "license": "No upstream license declared", "ref": "75931b865e95b0ab97aaca2a3756f4d0fab83a32"},
]


class RevisionConflict(ValueError):
    pass


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()).hexdigest()


def read_json(data):
    if len(data) > MAX_FILE:
        raise ValueError("A pose JSON file exceeds 2 MiB")
    def pairs(items):
        result = {}
        for key, value in items:
            if key in FORBIDDEN or key in result:
                raise ValueError("The pose contains reserved or duplicate fields")
            result[key] = value
        return result
    return json.loads(data.decode("utf-8-sig"), object_pairs_hook=pairs,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError("Non-finite number")))


def rig_names():
    with (ROOT / "web/vendor/assets/pose_studio_makehuman.v2.bin").open("rb") as handle:
        prefix = handle.read(12)
        if prefix[:8] != b"VNMHJS02":
            raise ValueError("The local mannequin rig is damaged")
        length = struct.unpack("<I", prefix[8:])[0]
        if length > 4 * 1024 * 1024:
            raise ValueError("The rig header is too large")
        header = json.loads(handle.read(length))
    return {bone["name"] for bone in header["bones"]}


def vectors(value, size=3):
    if not isinstance(value, dict) or len(value) > 1000:
        raise ValueError("Invalid joint rotations")
    result = {}
    for name, values in value.items():
        if name in FORBIDDEN or not isinstance(name, str) or len(name) > 100:
            raise ValueError("Invalid joint name")
        if not isinstance(values, list) or len(values) != size or not all(type(v) in (int, float) and math.isfinite(v) for v in values):
            raise ValueError(f"Invalid joint rotation: {name}")
        result[name] = list(values)
    return result


def normalize_pose(data, names=None):
    if not isinstance(data, dict):
        raise ValueError("Choose a pose JSON object")
    names = rig_names() if names is None else names
    kind = "anyangle"
    if data.get("kind") == "anyangle-pose" and data.get("version") == 1:
        pose = data.get("pose")
    elif data.get("schema_version") in (2, 3) and isinstance(data.get("characters"), list) and data["characters"]:
        kind = "vnccs"
        characters = data["characters"]
        actor = next((a for a in characters if a.get("id") == data.get("active_character_id")), characters[0])
        poses = actor.get("poses")
        tab = data.get("activeTab", 0)
        if not isinstance(poses, list) or not poses or type(tab) is not int or not 0 <= tab < len(poses):
            raise ValueError("VNCCS active character or pose not found")
        pose = poses[tab]
    elif isinstance(data.get("bones"), dict) and not any(key in data for key in ("source", "actors", "referenceLibrary")):
        kind, pose = "vnccs", data
    else:
        raise ValueError("Unrecognized pose. Use an AnyAngle pose or VNCCS rig JSON.")
    if not isinstance(pose, dict):
        raise ValueError("Missing pose data")
    bones = vectors(pose.get("bones"))
    unknown = sorted(set(bones) - names)
    known = {key: value for key, value in bones.items() if key in names}
    if not known:
        raise ValueError("The pose has no joints recognized by the local mannequin")
    result = {"bones": known}
    if kind == "anyangle":
        # Local saved poses already use this runtime's shaped-rest coordinate system.
        for key in ("bonePositions", "hipBonePosition", "positionDeltas"):
            if pose.get(key):
                result[key] = vectors(pose[key])
        if pose.get("modelRotation"):
            result["modelRotation"] = vectors({"rotation": pose["modelRotation"]})["rotation"]
    warnings = ["Unmapped bones: " + ", ".join(unknown)] if unknown else []
    if kind == "vnccs" and pose.get("hipBonePosition"):
        warnings.append("Target body shape preserved. You can adjust the pelvis and contact points manually.")
    return result, warnings


def category(name):
    lower = name.lower()
    for key, words in [("Dance", ("ballet", "dance", "arabesque", "attitude", "plie", "pirouette")),
                       ("Seated", ("sit", "seat", "chair")), ("Lying", ("lay", "lying", "prone", "fetal")),
                       ("Movement", ("box", "fight", "punch", "kick", "jump", "run", "walk", "step")),
                       ("Kneeling and Squatting", ("kneel", "squat", "crawl"))]:
        if any(word in lower for word in words):
            return key
    return "Standing"


def normalized_entry(data, name, source=None, names=None):
    if isinstance(data, dict) and data.get("kind") == "anyangle-animal-pose" and data.get("version") == 1:
        shape, rotations = data.get("shape"), data.get("rotations")
        if shape not in ("canine", "feline", "bunny", "owl"):
            raise ValueError("Choose a supported animal mannequin")
        if not isinstance(rotations, dict) or len(rotations) > 64 or any(
            not isinstance(key, str) or len(key) > 80 or key in ("__proto__", "constructor", "prototype")
            or not isinstance(rotation, list) or len(rotation) != 3
            or any(type(angle) not in (int, float) or not -math.pi <= angle <= math.pi for angle in rotation)
            for key, rotation in rotations.items()
        ):
            raise ValueError("Invalid animal joint rotations")
        if source is not None and not isinstance(source, dict):
            raise ValueError("Invalid pose metadata")
        source = {"id": "local", "name": "Local Import", "license": "User-provided", **(source or {})}
        name = str(name).strip()[:160] or "Animal Pose"
        pose = {"shape": shape, "rotations": rotations}
        return {"kind": "pose", "name": name, "originalName": name, "category": "Animal · " + shape.title(),
                "tags": [shape], "pose": pose, "source": source,
                "rigProfile": "anyangle-animal-radians", "warnings": [], "favorite": False, "poseHash": digest(pose)}
    if isinstance(data, dict) and data.get("kind") == "anyangle-composition" and data.get("version") == 1:
        slots = data.get("slots")
        if not isinstance(slots, list) or not 2 <= len(slots) <= 128:
            raise ValueError("A group arrangement needs 2 to 128 character slots")
        normalized = []
        for slot in slots:
            pose, _ = normalize_pose({"version": 1, "kind": "anyangle-pose", "pose": slot.get("pose")}, names)
            transform = {"x": 0, "y": 0, "z": 0, "yaw": 0, **slot.get("transform", {})}
            if not all(type(transform.get(key)) in (int, float) and math.isfinite(transform[key]) for key in ("x", "y", "z", "yaw")):
                raise ValueError("Invalid character placement in arrangement")
            normalized.append({"label": str(slot.get("label", "Character"))[:80], "pose": pose,
                               "transform": {key: transform[key] for key in ("x", "y", "z", "yaw")}})
        align = data.get("align", [])
        if not isinstance(align, list) or len(align) > 128:
            raise ValueError("Invalid arrangement contacts")
        for pair in align:
            if (not isinstance(pair, dict) or not isinstance(pair.get("slots"), list) or len(pair["slots"]) != 2
                    or not all(type(i) is int and 0 <= i < len(slots) for i in pair["slots"]) or pair["slots"][0] == pair["slots"][1]
                    or pair.get("hands") not in (["l", "l"], ["l", "r"], ["r", "l"], ["r", "r"])):
                raise ValueError("Invalid two-character hand mapping")
        entry = normalized_entry({"version": 1, "kind": "anyangle-pose", "pose": normalized[0]["pose"]}, name, source, names)
        entry.update(kind="composition", slots=normalized, align=align, category="Group Arrangement", poseHash=digest({"slots": normalized, "align": align}))
        return entry
    pose, warnings = normalize_pose(data, names)
    if source is not None and not isinstance(source, dict):
        raise ValueError("Invalid pose source")
    source = {"id": "local", "name": "Local Import", "license": "User-provided", **copy.deepcopy(source or {})}
    name = str(name).strip()[:160] or "Untitled Pose"
    return {"kind": "pose", "name": name, "originalName": name,
            "category": category(name), "tags": [], "pose": pose, "source": source,
            "rigProfile": "makehuman-v2-degrees", "warnings": warnings, "favorite": False,
            "poseHash": digest(pose)}


def preview_png(data):
    if len(data) > 4 * 1024 * 1024:
        raise ValueError("Preview exceeds 4 MiB")
    with Image.open(io.BytesIO(data)) as image:
        if image.format not in ("PNG", "JPEG", "WEBP") or image.width * image.height > 4_000_000:
            raise ValueError("Unsupported preview format or dimensions")
        image = image.convert("RGB")
        image.thumbnail((320, 320))
        output = io.BytesIO(); image.save(output, "PNG")
    return output.getvalue()


def safe_member(name):
    if not isinstance(name, str) or "\\" in name or ":" in name:
        raise ValueError("Invalid import path")
    parts = PurePosixPath(name).parts
    if name.startswith("/") or ".." in parts or not parts:
        raise ValueError("Import path is outside the selected folder")
    return "/".join(parts)


def inspect_files(files, source=None):
    if len(files) > MAX_FILES or sum(len(data) for data in files.values()) > MAX_PACK:
        raise ValueError("Pose pack exceeds 2,048 files or 64 MiB")
    clean = {safe_member(name): data for name, data in files.items()}
    names, entries, errors = rig_names(), [], []
    for path, data in clean.items():
        if not path.lower().endswith(".json") or PurePosixPath(path).name == "manifest.json":
            continue
        try:
            document = read_json(data)
            if document.get("kind") == "anyangle-pose-pack":
                continue
            provenance = {**(source or {}), "path": path}
            entry = normalized_entry(document, PurePosixPath(path).stem, provenance, names)
            entry["importPath"] = path
            stem = path.rsplit(".", 1)[0]
            for ext in (".webp", ".png", ".jpg", ".jpeg"):
                if stem + ext in clean:
                    try:
                        entry["previewData"] = base64.b64encode(preview_png(clean[stem + ext])).decode()
                    except (ValueError, OSError, Image.DecompressionBombError) as error:
                        entry["warnings"].append(str(error))
                    break
            entries.append(entry)
        except (ValueError, TypeError, KeyError, AttributeError, RecursionError) as error:
            errors.append({"path": path, "error": str(error)})
    return {"entries": entries, "errors": errors}


def inspect_zip(data):
    if len(data) > MAX_PACK:
        raise ValueError("Pose ZIP exceeds 64 MiB")
    files = {}
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        members = archive.infolist()
        if len(members) > MAX_FILES or sum(item.file_size for item in members) > MAX_PACK:
            raise ValueError("Extracted pose ZIP exceeds its size limit")
        for item in members:
            name = safe_member(item.filename)
            if item.is_dir():
                continue
            if item.external_attr >> 16 & 0o170000 == 0o120000:
                raise ValueError("Pose packs cannot contain symbolic links")
            if name in files:
                raise ValueError("Pose pack contains duplicate filenames")
            if item.file_size > 4 * 1024 * 1024 or item.file_size > max(1, item.compress_size) * 1000:
                raise ValueError("A pose pack entry is too large or has an invalid compression ratio")
            if Path(name).suffix.lower() in (".json", ".png", ".webp", ".jpg", ".jpeg"):
                files[name] = archive.read(item)
    manifests = [(name, raw) for name, raw in files.items() if PurePosixPath(name).name == "manifest.json"]
    for name, raw in manifests:
        manifest = read_json(raw)
        if manifest.get("kind") == "anyangle-pose-pack" and manifest.get("version") == 1:
            result = inspect_files(files)
            metadata = {row.get("file"): row for row in manifest.get("items", []) if isinstance(row, dict)}
            for entry in result["entries"]:
                row = metadata.get(entry["importPath"], {})
                for key in ("name", "originalName", "category", "tags", "favorite", "source"):
                    if key in row:
                        entry[key] = row[key]
            return result
    # A source archive may include scripts and workflows: only its pose_library tree is data.
    scoped = {name: raw for name, raw in files.items() if "pose_library" in PurePosixPath(name).parts}
    return inspect_files(scoped or files)


def builtin_entries():
    presets = json.loads((ROOT / "web/editor/builtin-poses.json").read_text("utf-8"))
    entries = [{**normalized_entry({"version": 1, "kind": "anyangle-pose", "pose": {"bones": p["bones"]}}, p["name"],
                               {"id": "builtin", "name": "AnyAngle Built-in", "license": "Original project pose"}),
             "id": "builtin-" + str(i), "builtin": True, "category": p.get("category", "站姿")}
            for i, p in enumerate(presets)]
    for i, (name, yaw, align) in enumerate((("双人合影", [0, 0], []), ("双人对话", [70, -70], []), ("双人握手", [90, -90], [{"slots": [0, 1], "hands": ["r", "r"]}]))):
        slots = [{"label": f"人物{j+1}", "pose": {"bones": presets[0]["bones"]}, "transform": {"x": j * (4 if align else 7), "y": 0, "z": 0, "yaw": yaw[j]}} for j in range(2)]
        entry = normalized_entry({"version": 1, "kind": "anyangle-composition", "slots": slots, "align": align}, name,
                                 {"id": "builtin", "name": "AnyAngle Built-in Arrangements", "license": "Original project arrangement"})
        entries.append({**entry, "id": f"builtin-composition-{i}", "builtin": True})
    english_names = {
        "自然站立": "Natural Stand", "迈步": "Step Forward", "坐姿": "Seated",
        "举手": "Raised Hand", "双臂伸展": "Arms Outstretched", "向上伸展": "Overhead Stretch",
        "挥手致意": "Wave", "跑步准备": "Ready to Run", "单腿平衡": "One-Leg Balance",
        "低头阅读": "Looking Down to Read", "对话手势": "Conversation Gesture",
        "交叉坐姿": "Seated with Crossed Legs", "双人合影": "Two-Person Photo",
        "双人对话": "Two-Person Conversation", "双人握手": "Handshake",
    }
    english_categories = {"站姿": "Standing", "坐姿": "Seated", "运动": "Movement", "多人编排": "Group Arrangement"}
    for entry in entries:
        entry["name"] = english_names.get(entry["originalName"], entry["name"])
        entry["category"] = english_categories.get(entry["category"], entry["category"])
        entry["builtinPreview"] = entry["id"] + ".png"
    animals = {
        "canine": ("Canine · Alert", {"Head": [-0.21, 0, 0], "Tail base": [0.5, 0, 0]}),
        "feline": ("Feline · Paw Lift", {"Left foreleg root": [-0.32, 0, 0], "Left foreleg joint 1": [0.72, 0, 0], "Chest": [-0.07, 0, 0]}),
        "bunny": ("Bunny · Listening", {"Head": [-0.2, 0, 0], "Left ear": [0, 0, -0.22], "Right ear": [0, 0, 0.22]}),
        "owl": ("Owl · Wings Raised", {"Left wing root": [0, 0, 0.48], "Right wing root": [0, 0, -0.48]}),
    }
    for shape, (action, rotations) in animals.items():
        for key, name, pose in (("rest", shape.title() + " · Neutral", {}), ("action", action, rotations)):
            entry = normalized_entry({"version": 1, "kind": "anyangle-animal-pose", "shape": shape, "rotations": pose},
                                     name, {"id": "builtin", "name": "AnyAngle Built-in", "license": "Project original"})
            entries.append({**entry, "id": f"builtin-{shape}-{key}", "builtin": True})
    return entries


class PoseLibraryStore:
    def __init__(self, root):
        self.root = Path(root).absolute()
        if any(path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction()) for path in [self.root, *self.root.parents]):
            raise ValueError("The pose library cannot use linked folders")
        self.root.mkdir(parents=True, exist_ok=True)

    def path(self, name):
        if name != "index.json" and not re.fullmatch(r"[a-f0-9]{64}\.(json|png)", name):
            raise ValueError("Invalid pose library asset name")
        path = self.root / name
        if path.is_symlink() or path.resolve().parent != self.root.resolve():
            raise ValueError("Pose library asset path is outside its storage directory")
        return path

    def write(self, name, data):
        with tempfile.NamedTemporaryFile(dir=self.root, delete=False) as handle:
            temporary = Path(handle.name); handle.write(data)
        try:
            os.replace(temporary, self.path(name))
        finally:
            temporary.unlink(missing_ok=True)

    def read(self):
        path = self.path("index.json")
        if not path.exists():
            return {"version": 1, "revision": 0, "items": [], "sources": {}}
        value = json.loads(path.read_text("utf-8"))
        if value.get("version") != 1 or not isinstance(value.get("items"), list):
            raise ValueError("The pose library index is damaged. Restore it from an export.")
        return value

    def list(self):
        with LOCK:
            index = self.read()
            builtins = builtin_entries()
            for row in builtins:
                row.update(index.get("overrides", {}).get(row["id"], {}))
            index["items"] = builtins + index["items"]
            index["catalog"] = SOURCES
            return index

    def commit(self, revision, operation):
        with LOCK:
            index = self.read()
            if type(revision) is not int or revision != index["revision"]:
                raise RevisionConflict("The pose library changed in another window. Refresh and try again.")
            operation(index)
            index["revision"] += 1
            self.write("index.json", json.dumps(index, ensure_ascii=False, allow_nan=False).encode())
            return self.list()

    def import_entries(self, entries, revision):
        if not isinstance(entries, list) or not entries or len(entries) > MAX_FILES:
            raise ValueError("Choose valid poses to add to the library")
        prepared = []
        builtins = {(row['originalName'], row['poseHash']): row['id'] for row in builtin_entries()}
        for row in entries:
            if not isinstance(row, dict):
                raise ValueError("Invalid pose entry")
            data = ({"kind": "anyangle-composition", "version": 1, "slots": row.get("slots"), "align": row.get("align", [])}
                    if row.get("kind") == "composition" else {"kind": "anyangle-pose", "version": 1, "pose": row.get("pose")})
            if row.get("rigProfile") == "anyangle-animal-radians" and isinstance(row.get("pose"), dict):
                data = {**row["pose"], "kind": "anyangle-animal-pose", "version": 1}
            entry = normalized_entry(data, row.get("originalName") or row.get("name", ""), row.get("source"))
            for key in ("name", "category"):
                if key in row:
                    if not isinstance(row[key], str) or len(row[key]) > 160:
                        raise ValueError("Pose name or category is too long")
                    entry[key] = row[key]
            tags = row.get("tags", [])
            if not isinstance(tags, list) or len(tags) > 64 or not all(isinstance(tag, str) and len(tag) < 100 for tag in tags):
                raise ValueError("Invalid pose tags")
            entry["tags"], entry["favorite"] = tags, bool(row.get("favorite"))
            warnings = row.get("warnings", [])
            if not isinstance(warnings, list) or not all(isinstance(value, str) and len(value) < 1000 for value in warnings):
                raise ValueError("Invalid compatibility notes")
            entry["warnings"] = list(dict.fromkeys(entry["warnings"] + warnings))
            source = entry["source"]
            if not isinstance(source, dict) or len(json.dumps(source)) > 4096:
                raise ValueError("Invalid pose source")
            identity = {"source": source.get("id", "local"), "path": source.get("path", entry["originalName"])}
            if identity["source"] == "local":
                identity["pose"] = entry["poseHash"]
            entry["id"] = digest(identity)
            builtin_id = builtins.get((entry["originalName"], entry["poseHash"])) if source.get("id") == "builtin" else None
            if builtin_id:
                entry.update(id=builtin_id, builtin=True)
            entry["createdAt"] = datetime.now(timezone.utc).isoformat()
            if row.get("previewData"):
                raw = preview_png(base64.b64decode(row["previewData"], validate=True))
                name = hashlib.sha256(raw).hexdigest() + ".png"
                entry["preview"] = name
                self.write(name, raw)
            elif isinstance(row.get("preview"), str) and row["preview"].endswith(".png") and self.path(row["preview"]).is_file():
                entry["preview"] = row["preview"]
            prepared.append(entry)
        def update(index):
            by_id = {row["id"]: row for row in index["items"]}
            for entry in prepared:
                if entry.get("builtin"):
                    overrides = index.setdefault("overrides", {}).setdefault(entry["id"], {})
                    for key in ("name", "category", "favorite", "tags", "preview"):
                        if key in entry:
                            overrides.setdefault(key, entry[key])
                    continue
                previous = by_id.get(entry["id"])
                if not previous and entry["source"].get("id") not in (None, "local") and entry["source"].get("path"):
                    previous = next((row for row in by_id.values() if row["source"].get("id") == entry["source"].get("id")
                                     and row["source"].get("path") == entry["source"].get("path")), None)
                if previous:
                    entry["id"] = previous["id"]
                    for key in ("name", "favorite", "tags", "hidden", "createdAt"):
                        if key in previous:
                            entry[key] = previous[key]
                    if not entry.get("preview") and previous.get("preview"):
                        entry["preview"] = previous["preview"]
                by_id[entry["id"]] = entry
            index["items"] = list(by_id.values())
        return self.commit(revision, update)

    def patch(self, item_id, values, revision):
        builtin = next((row for row in builtin_entries() if row["id"] == item_id), None)
        if not builtin and not TOKEN.fullmatch(item_id or ""):
            raise ValueError("Invalid pose entry")
        def update(index):
            entry = index.setdefault("overrides", {}).setdefault(item_id, {}) if builtin else next((row for row in index["items"] if row["id"] == item_id), None)
            if entry is None:
                raise ValueError("Pose not found")
            for key, value in values.items():
                if key in ("name", "category") and isinstance(value, str) and 0 < len(value.strip()) <= 160:
                    entry[key] = value.strip()
                elif key in ("favorite", "hidden") and type(value) is bool:
                    entry[key] = value
                elif key == "tags" and isinstance(value, list) and len(value) <= 64 and all(isinstance(tag, str) and len(tag) < 100 for tag in value):
                    entry[key] = value
                elif key == "previewData" and isinstance(value, str):
                    raw = preview_png(base64.b64decode(value, validate=True))
                    name = hashlib.sha256(raw).hexdigest() + ".png"
                    self.write(name, raw)
                    entry["preview"] = name
                else:
                    raise ValueError("Invalid pose edit field")
        return self.commit(revision, update)

    def delete(self, ids, revision):
        if not isinstance(ids, list) or not all(isinstance(value, str) and TOKEN.fullmatch(value) for value in ids):
            raise ValueError("Choose a user pose. Built-in poses can be hidden.")
        return self.commit(revision, lambda index: index.update(items=[row for row in index["items"] if row["id"] not in ids]))

    def export(self, ids=None):
        if ids is not None and (not isinstance(ids, list) or not all(isinstance(value, str) for value in ids)):
            raise ValueError("Pose IDs to export must be a list")
        items = self.list()["items"]
        if ids is not None:
            items = [row for row in items if row["id"] in ids]
        output, manifest = io.BytesIO(), {"version": 1, "kind": "anyangle-pose-pack", "items": []}
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
            for row in items:
                file = row["id"] + ".json"
                payload = ({"version": 1, "kind": "anyangle-composition", "slots": row["slots"], "align": row.get("align", [])}
                           if row.get("kind") == "composition" else {"version": 1, "kind": "anyangle-pose", "pose": row["pose"]})
                if row.get("rigProfile") == "anyangle-animal-radians":
                    payload = {**row["pose"], "version": 1, "kind": "anyangle-animal-pose"}
                archive.writestr(file, json.dumps(payload))
                manifest["items"].append({**{key: row[key] for key in ("name", "originalName", "category", "tags", "favorite", "source")}, "file": file})
                if row.get("preview"):
                    archive.writestr(row["id"] + ".png", self.path(row["preview"]).read_bytes())
                elif row.get("builtinPreview"):
                    preview = ROOT / "web/editor/pose-previews" / row["builtinPreview"]
                    if preview.is_file():
                        archive.writestr(row["id"] + ".png", preview.read_bytes())
            archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
        return output.getvalue()


def remote_bytes(url, maximum=MAX_FILE):
    request = urllib.request.Request(url, headers={"User-Agent": "AnyAngle-Studio-pose-library", "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        data = response.read(maximum + 1)
    if len(data) > maximum:
        raise ValueError("Source file exceeds the size limit")
    return data


def fetch_source(source_id, latest=False, progress=None):
    source = next((row for row in SOURCES if row["id"] == source_id), None)
    if not source:
        raise ValueError("Choose a built-in pose source")
    source = dict(source); repo = source["repo"]; ref = source["ref"]
    if source["host"] == "github":
        if latest:
            ref = json.loads(remote_bytes(f"https://api.github.com/repos/{repo}/commits/main"))["sha"]
        tree = json.loads(remote_bytes(f"https://api.github.com/repos/{repo}/git/trees/{ref}?recursive=1"))["tree"]
        all_paths = {row["path"] for row in tree if row.get("type") == "blob"}
        paths = [path for path in sorted(all_paths) if path.startswith(source["prefix"]) and path.lower().endswith(".json")]
        base = f"https://raw.githubusercontent.com/{repo}/{ref}/"
    else:
        metadata = json.loads(remote_bytes(f"https://huggingface.co/api/models/{repo}"))
        if latest:
            ref = metadata["sha"]
        else:
            metadata = json.loads(remote_bytes(f"https://huggingface.co/api/models/{repo}/revision/{ref}"))
        all_paths = {row["rfilename"] for row in metadata["siblings"]}
        paths = [path for path in sorted(all_paths) if path.lower().endswith(".json") and path != "pose_library.json"]
        base = f"https://huggingface.co/{repo}/resolve/{ref}/"
    if len(paths) > MAX_FILES:
        raise ValueError("Source exceeds the file count limit")
    manifest = {}
    if "pose_library.json" in all_paths:
        document = json.loads(remote_bytes(base + "pose_library.json"))
        manifest = {safe_member(row["json_path"]): row for row in document.get("poses", []) if isinstance(row, dict) and isinstance(row.get("json_path"), str)}
    source["ref"] = ref
    result, errors, names = [], [], rig_names()
    for i, path in enumerate(paths):
        if progress:
            progress(i, len(paths), path)
        try:
            raw = remote_bytes(base + urllib.parse.quote(safe_member(path), safe="/"))
            provenance = {**source, "path": path, "sha256": hashlib.sha256(raw).hexdigest()}
            metadata = manifest.get(path, {})
            if metadata.get("json_sha256") and metadata["json_sha256"] != provenance["sha256"]:
                raise ValueError("Source JSON SHA-256 does not match the manifest")
            entry = normalized_entry(read_json(raw), metadata.get("name") or PurePosixPath(path).stem, provenance, names)
            if source_id == "ballet":
                entry["category"] = "Dance"
            entry["tags"] = metadata.get("tags", [])
            image_path = metadata.get("preview_path")
            if not image_path:
                stem = path.rsplit(".", 1)[0]
                image_path = next((stem + ext for ext in (".webp", ".png", ".jpg") if stem + ext in all_paths), None)
            if image_path and image_path in all_paths:
                try:
                    image = remote_bytes(base + urllib.parse.quote(safe_member(image_path), safe="/"), 4 * 1024 * 1024)
                    if metadata.get("preview_sha256") and metadata["preview_sha256"] != hashlib.sha256(image).hexdigest():
                        raise ValueError("Source preview SHA-256 does not match the manifest")
                    entry["previewData"] = base64.b64encode(preview_png(image)).decode()
                except (OSError, ValueError, Image.DecompressionBombError) as error:
                    entry["warnings"].append(f"Preview could not be loaded: {error}")
            result.append(entry)
        except (ValueError, TypeError, OSError, AttributeError, KeyError) as error:
            errors.append({"path": path, "error": str(error)})
    if progress:
        progress(len(paths), len(paths), "")
    return {"entries": result, "errors": errors, "source": source, "candidateCount": len(paths)}
