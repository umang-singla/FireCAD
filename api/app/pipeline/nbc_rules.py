from typing import Any, Dict, List, Optional, Tuple

# ============================================================
# NBC 2005 Part 4 - Table 23 rule engine
# Built from Table 23 pages 35-42 and Notes 1-23
# ============================================================

EQUIPMENT_LABELS = {
    "fire_extinguisher": "Fire Extinguisher",
    "hose_reel": "Hose Reel",
    "dry_riser": "Dry Riser",
    "wet_riser": "Wet Riser",
    "downcomer": "Downcomer",
    "yard_hydrant": "Yard Hydrant",
    "auto_sprinkler": "Automatic Sprinkler System",
    "manual_fire_alarm": "Manually Operated Electric Fire Alarm System",
    "auto_detection_alarm": "Automatic Detection and Alarm System",
}

# Which equipment keys our app currently supports placing on drawings
SUPPORTED_EQUIPMENT = {"auto_sprinkler", "auto_detection_alarm"}

NOTES = {
    1: "Buildings above 15 m in height are not permitted for occupancies A-1 and A-2.",
    2: "Automatic sprinkler system is required in basement if basement area exceeds 200 m².",
    3: "Terrace tank / related provision is required if basement area exceeds 200 m².",
    4: "Additional value shown in parentheses shall be added if basement area exceeds 200 m².",
    5: "Required for buildings with more than two storeys (Ground + One).",
    6: "Dry riser may be used in hilly areas, industrial areas or as required by local authority.",
    7: "Required for buildings with height above 15 m.",
    8: "To be installed in basement; if basement used for car parking and area exceeds 750 m², sprinkler shall be fed from both underground static water storage tank and terrace tank.",
    9: "Required for buildings with more than one storey.",
    10: "To be installed in entire building.",
    11: "To be installed in all floors at appropriate places and in consultation with local fire authorities.",
    12: "Buildings above 30 m in height are not permitted for Groups B, C, D and F occupancies.",
    13: "All underground shopping areas should be fully air-conditioned.",
    14: "Group G table is for small-scale industry units; for other industries, use relevant Indian Standards and consult local fire authorities.",
    15: "Buildings above 18 m in height are not permitted for G-1 and G-2 occupancies.",
    16: "Buildings above 15 m in height are not permitted for G-3 occupancies.",
    17: "Buildings above 15 m in height are not permitted for Groups H and J occupancies.",
    18: "Pump capacity shall be based on the covered area of the building.",
    19: "One electric and one diesel pump of capacity 1620 l/min and one electric pump of capacity 180 l/min.",
    20: "One electric and one diesel pump of capacity 2280 l/min and one electric pump of capacity 180 l/min.",
    21: "Two electric and one diesel pump of capacity 2280 l/min and one electric pump of capacity 180 l/min.",
    22: "Two electric and one diesel pump of capacity 2850 l/min and one electric pump of capacity 180 l/min.",
    23: "For buildings above 45 m, if sprinkler system is required at terrace level, the main pump, sprinkler pump, jockey pump and common pump need not be provided; however one automatic electric fire pump of 900 lpm is required.",
}

COMMON_QUESTIONS: List[Dict[str, Any]] = [
    {
        "id": "occupancy_subtype",
        "type": "select",
        "label": "Which occupancy subtype best matches the building?",
        "options": [
            "A1_lodging_rooming_house",
            "A2_private_dwelling",
            "A3_dormitory",
            "A4_apartment_house",
            "A5_hotel",
            "A6_hotel_special",
            "B_educational",
            "C1_hospital_nursing_home",
            "C2_custodial",
            "C3_penal_mental",
            "D1_D5_assembly",
            "D6_multiplex",
            "D7_special_assembly",
            "E_business",
            "F1_F2_mercantile",
            "F3_underground_shopping",
            "G1_low_hazard_industrial",
            "G2_moderate_hazard_industrial",
            "G3_high_hazard_industrial",
            "H_storage",
            "J_hazardous",
        ],
    },
    {"id": "height_m", "type": "number", "label": "Building height in metres"},
    {"id": "above_ground_storeys", "type": "number", "label": "Number of above-ground storeys including ground"},
    {"id": "basement_area_m2", "type": "number", "label": "Basement area in m² (0 if none)"},
    {"id": "basement_car_parking_area_m2", "type": "number", "label": "Basement car-parking area in m² (0 if none)"},
]

OCCUPANCY_DISPLAY_LABELS: Dict[str, str] = {
    "A1_lodging_rooming_house": "A-1 Lodging / Rooming House",
    "A2_private_dwelling": "A-2 Private Dwelling",
    "A3_dormitory": "A-3 Dormitory",
    "A4_apartment_house": "A-4 Apartment House",
    "A5_hotel": "A-5 Hotel",
    "A6_hotel_special": "A-6 Hotel (Special)",
    "B_educational": "B Educational Building",
    "C1_hospital_nursing_home": "C-1 Hospital / Nursing Home",
    "C2_custodial": "C-2 Custodial",
    "C3_penal_mental": "C-3 Penal / Mental",
    "D1_D5_assembly": "D-1 to D-5 Assembly",
    "D6_multiplex": "D-6 Multiplex",
    "D7_special_assembly": "D-7 Special Assembly",
    "E_business": "E Business",
    "F1_F2_mercantile": "F-1 / F-2 Mercantile",
    "F3_underground_shopping": "F-3 Underground Shopping",
    "G1_low_hazard_industrial": "G-1 Low Hazard Industrial",
    "G2_moderate_hazard_industrial": "G-2 Moderate Hazard Industrial",
    "G3_high_hazard_industrial": "G-3 High Hazard Industrial",
    "H_storage": "H Storage",
    "J_hazardous": "J Hazardous",
}

FOLLOWUP_QUESTIONS: Dict[str, List[Dict[str, Any]]] = {
    "A1_lodging_rooming_house": [
        {"id": "rooms", "type": "number", "label": "Number of letting rooms"},
    ],
    "A5_hotel": [
        {"id": "covered_area_per_floor_m2", "type": "number", "label": "Covered area per floor in m²"},
    ],
    "C1_hospital_nursing_home": [
        {"id": "plot_area_m2", "type": "number", "label": "Plot area in m²"},
        {"id": "beds_present", "type": "boolean", "label": "Are there patient beds?"},
    ],
    "C2_custodial": [
        {"id": "occupant_load", "type": "number", "label": "Maximum number of persons"},
    ],
    "C3_penal_mental": [
        {"id": "occupant_load", "type": "number", "label": "Maximum number of persons"},
    ],
    "D1_D5_assembly": [
        {"id": "occupant_load", "type": "number", "label": "Maximum number of persons"},
    ],
    "F1_F2_mercantile": [
        {"id": "total_covered_area_m2", "type": "number", "label": "Total covered area in m²"},
    ],
    "G1_low_hazard_industrial": [
        {"id": "built_up_area_m2", "type": "number", "label": "Built-up area in m²"},
        {"id": "small_scale_industry", "type": "boolean", "label": "Is this a small-scale industry unit?"},
    ],
    "G2_moderate_hazard_industrial": [
        {"id": "built_up_area_m2", "type": "number", "label": "Built-up area in m²"},
        {"id": "small_scale_industry", "type": "boolean", "label": "Is this a small-scale industry unit?"},
    ],
    "G3_high_hazard_industrial": [
        {"id": "built_up_area_m2", "type": "number", "label": "Built-up area in m²"},
        {"id": "small_scale_industry", "type": "boolean", "label": "Is this a small-scale industry unit?"},
    ],
    "H_storage": [
        {"id": "covered_area_m2", "type": "number", "label": "Covered area in m²"},
    ],
}


def get_questions(occupancy_subtype: Optional[str] = None) -> List[Dict[str, Any]]:
    qs = list(COMMON_QUESTIONS)
    if occupancy_subtype:
        qs.extend(FOLLOWUP_QUESTIONS.get(occupancy_subtype, []))
    return qs


def _cond(*codes: str) -> Dict[str, Any]:
    return {"type": "conditional", "codes": list(codes)}


def _raw(value: Any) -> Dict[str, Any]:
    return {"type": "raw", "value": value}


RULES = [
    # A - Residential
    {
        "id": "A1_lt15_upto15_rooms",
        "occupancy_subtype": "A1_lodging_rooming_house",
        "category": "A-1 Lodging / Rooming House",
        "conditions": {"height_lt": 15, "rooms_lte": 15},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("NR"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("NR"), "downcomer": _raw("NR"), "yard_hydrant": _raw("NR"),
            "auto_sprinkler": _cond("NOTE2"), "manual_fire_alarm": _raw("NR"), "auto_detection_alarm": _raw("NR"),
        },
        "water_pump": {"underground_static_tank_l": "NR", "terrace_tank_l": "5000_if_basement_gt_200", "pump_near_underground_tank": "NR", "pump_at_terrace_lpm": "NR"},
    },
    {
        "id": "A1_lt15_16_to_30_rooms",
        "occupancy_subtype": "A1_lodging_rooming_house",
        "category": "A-1 Lodging / Rooming House",
        "conditions": {"height_lt": 15, "rooms_gt": 15, "rooms_lte": 30},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("NR"), "downcomer": _raw("NR"), "yard_hydrant": _raw("NR"),
            "auto_sprinkler": _cond("NOTE2"), "manual_fire_alarm": _raw("NR"), "auto_detection_alarm": _raw("NR"),
        },
        "water_pump": {"underground_static_tank_l": "NR", "terrace_tank_l": "5000_plus_5000_if_basement_gt_200", "pump_near_underground_tank": "NR", "pump_at_terrace_lpm": "450_plus_450_if_basement_gt_200"},
    },
    {
        "id": "A1_lt15_more_than_30_rooms",
        "occupancy_subtype": "A1_lodging_rooming_house",
        "category": "A-1 Lodging / Rooming House",
        "conditions": {"height_lt": 15, "rooms_gt": 30},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("NR"), "downcomer": _raw("NR"), "yard_hydrant": _raw("NR"),
            "auto_sprinkler": _cond("NOTE2"), "manual_fire_alarm": _cond("NOTE5"), "auto_detection_alarm": _raw("NR"),
        },
        "water_pump": {"underground_static_tank_l": "NR", "terrace_tank_l": "10000_plus_5000_if_basement_gt_200", "pump_near_underground_tank": "NR", "pump_at_terrace_lpm": "450_plus_450_if_basement_gt_200"},
    },
    {
        "id": "A2_private_dwelling",
        "occupancy_subtype": "A2_private_dwelling",
        "category": "A-2 One or Two Family Private Dwellings",
        "conditions": {"height_lt": 15},
        "equip": {k: _raw("NR") for k in EQUIPMENT_LABELS},
        "water_pump": {"underground_static_tank_l": "NR", "terrace_tank_l": "NR", "pump_near_underground_tank": "NR", "pump_at_terrace_lpm": "NR"},
    },
    {
        "id": "A3A4_lt15",
        "occupancy_subtype": ["A3_dormitory", "A4_apartment_house"],
        "category": "A-3 Dormitory / A-4 Apartment House",
        "conditions": {"height_lt": 15},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("NR"), "downcomer": _raw("NR"), "yard_hydrant": _raw("NR"),
            "auto_sprinkler": _cond("NOTE2"), "manual_fire_alarm": _raw("NR"), "auto_detection_alarm": _raw("NR"),
        },
        "water_pump": {"underground_static_tank_l": "NR", "terrace_tank_l": "5000_plus_5000_if_basement_gt_200", "pump_near_underground_tank": "NR", "pump_at_terrace_lpm": "450_plus_450_if_basement_gt_200"},
    },
    {
        "id": "A3A4_15_to_35",
        "occupancy_subtype": ["A3_dormitory", "A4_apartment_house"],
        "category": "A-3 Dormitory / A-4 Apartment House",
        "conditions": {"height_gte": 15, "height_lte": 35},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("NR"), "downcomer": _raw("R"), "yard_hydrant": _raw("NR"),
            "auto_sprinkler": _cond("NOTE2"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("NR"),
        },
        "water_pump": {"underground_static_tank_l": "NR", "terrace_tank_l": "25000", "pump_near_underground_tank": "NR", "pump_at_terrace_lpm": "900"},
    },
    {
        "id": "A3A4_35_to_45",
        "occupancy_subtype": ["A3_dormitory", "A4_apartment_house"],
        "category": "A-3 Dormitory / A-4 Apartment House",
        "conditions": {"height_gt": 35, "height_lte": 45},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("R"), "downcomer": _raw("NR"), "yard_hydrant": _raw("NR"),
            "auto_sprinkler": _cond("NOTE2", "NOTE8"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("NR"),
        },
        "water_pump": {"underground_static_tank_l": "75000", "terrace_tank_l": "5000_plus_5000_if_basement_gt_200", "pump_near_underground_tank": "as_per_note_19", "pump_at_terrace_lpm": "NR"},
    },
    {
        "id": "A3A4_45_to_60",
        "occupancy_subtype": ["A3_dormitory", "A4_apartment_house"],
        "category": "A-3 Dormitory / A-4 Apartment House",
        "conditions": {"height_gt": 45, "height_lte": 60},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("R"), "downcomer": _raw("NR"), "yard_hydrant": _raw("R"),
            "auto_sprinkler": _raw("R"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("NR"),
        },
        "water_pump": {"underground_static_tank_l": "75000", "terrace_tank_l": "10000", "pump_near_underground_tank": "as_per_note_20", "pump_at_terrace_lpm": "NR"},
    },
    {
        "id": "A3A4_above_60",
        "occupancy_subtype": ["A3_dormitory", "A4_apartment_house"],
        "category": "A-3 Dormitory / A-4 Apartment House",
        "conditions": {"height_gt": 60},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("R"), "downcomer": _raw("NR"), "yard_hydrant": _raw("R"),
            "auto_sprinkler": _raw("R"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "100000", "terrace_tank_l": "25000", "pump_near_underground_tank": "as_per_note_21", "pump_at_terrace_lpm": "NR"},
    },
    {
        "id": "A5_lt15_area_le_300",
        "occupancy_subtype": "A5_hotel",
        "category": "A-5 Hotel",
        "conditions": {"height_lt": 15, "covered_area_per_floor_lte": 300},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("NR"), "downcomer": _raw("NR"), "yard_hydrant": _raw("NR"),
            "auto_sprinkler": _cond("NOTE2"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("NR"),
        },
        "water_pump": {"underground_static_tank_l": "NR", "terrace_tank_l": "5000_if_basement_gt_200", "pump_near_underground_tank": "NR", "pump_at_terrace_lpm": "450_if_basement_gt_200"},
    },
    {
        "id": "A5_lt15_area_300_to_1000",
        "occupancy_subtype": "A5_hotel",
        "category": "A-5 Hotel",
        "conditions": {"height_lt": 15, "covered_area_per_floor_gt": 300, "covered_area_per_floor_lte": 1000},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _cond("NOTE5"), "downcomer": _raw("NR"), "yard_hydrant": _raw("NR"),
            "auto_sprinkler": _cond("NOTE2"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "10000_per_500_m2_subject_to_min_50000", "terrace_tank_l": "10000", "pump_near_underground_tank": "as_per_note_19_and_note5", "pump_at_terrace_lpm": "NR"},
    },
    {
        "id": "A5_lt15_area_gt_1000",
        "occupancy_subtype": "A5_hotel",
        "category": "A-5 Hotel",
        "conditions": {"height_lt": 15, "covered_area_per_floor_gt": 1000},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _cond("NOTE9"), "downcomer": _raw("NR"), "yard_hydrant": _raw("R"),
            "auto_sprinkler": _cond("NOTE10"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "100000", "terrace_tank_l": "10000", "pump_near_underground_tank": "as_per_note_19_and_note9", "pump_at_terrace_lpm": "NR"},
    },
    {
        "id": "A5_15_to_30",
        "occupancy_subtype": "A5_hotel",
        "category": "A-5 Hotel",
        "conditions": {"height_gte": 15, "height_lte": 30},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("R"), "downcomer": _raw("NR"), "yard_hydrant": _raw("R"),
            "auto_sprinkler": _cond("NOTE10"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "150000", "terrace_tank_l": "20000", "pump_near_underground_tank": "as_per_note_20", "pump_at_terrace_lpm": "NR"},
    },
    {
        "id": "A5_above_30",
        "occupancy_subtype": "A5_hotel",
        "category": "A-5 Hotel",
        "conditions": {"height_gt": 30},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("R"), "downcomer": _raw("NR"), "yard_hydrant": _raw("R"),
            "auto_sprinkler": _cond("NOTE10"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "200000", "terrace_tank_l": "20000", "pump_near_underground_tank": "as_per_note_21", "pump_at_terrace_lpm": "NR"},
    },
    {
        "id": "A6_hotel_special",
        "occupancy_subtype": "A6_hotel_special",
        "category": "A-6 Hotel (special category)",
        "conditions": {},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("R"), "downcomer": _raw("NR"), "yard_hydrant": _raw("R"),
            "auto_sprinkler": _cond("NOTE10"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "200000", "terrace_tank_l": "20000", "pump_near_underground_tank": "as_per_note_22", "pump_at_terrace_lpm": "NR"},
    },
    # B - Educational
    {
        "id": "B_lt15_ground_plus_one",
        "occupancy_subtype": "B_educational",
        "category": "B Educational Building",
        "conditions": {"height_lt": 15, "above_ground_storeys_lte": 2},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("NR"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("NR"), "downcomer": _raw("NR"), "yard_hydrant": _raw("NR"),
            "auto_sprinkler": _cond("NOTE2"), "manual_fire_alarm": _raw("NR"), "auto_detection_alarm": _raw("NR"),
        },
        "water_pump": {"underground_static_tank_l": "NR", "terrace_tank_l": "5000_if_basement_gt_200", "pump_near_underground_tank": "NR", "pump_at_terrace_lpm": "450_if_basement_gt_200"},
    },
    {
        "id": "B_lt15_ground_plus_two_or_more",
        "occupancy_subtype": "B_educational",
        "category": "B Educational Building",
        "conditions": {"height_lt": 15, "above_ground_storeys_gt": 2},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("NR"), "downcomer": _raw("NR"), "yard_hydrant": _raw("NR"),
            "auto_sprinkler": _cond("NOTE2"), "manual_fire_alarm": _raw("NR"), "auto_detection_alarm": _raw("NR"),
        },
        "water_pump": {"underground_static_tank_l": "NR", "terrace_tank_l": "10000_plus_5000_if_basement_gt_200", "pump_near_underground_tank": "NR", "pump_at_terrace_lpm": "450_plus_450_if_basement_gt_200"},
    },
    {
        "id": "B_15_to_30",
        "occupancy_subtype": "B_educational",
        "category": "B Educational Building",
        "conditions": {"height_gte": 15, "height_lte": 30},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("NR"), "downcomer": _raw("R"), "yard_hydrant": _raw("NR"),
            "auto_sprinkler": _cond("NOTE2"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("NR"),
        },
        "water_pump": {"underground_static_tank_l": "NR", "terrace_tank_l": "25000", "pump_near_underground_tank": "NR", "pump_at_terrace_lpm": "900"},
    },
    # C - Institutional
    {
        "id": "C1_lt15_plot_upto_1000_gplus1_no_beds",
        "occupancy_subtype": "C1_hospital_nursing_home",
        "category": "C-1 Hospital / Nursing Home",
        "conditions": {"height_lt": 15, "plot_area_lte": 1000, "above_ground_storeys_lte": 2, "beds_present": False},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("NR"), "downcomer": _raw("NR"), "yard_hydrant": _raw("NR"),
            "auto_sprinkler": _cond("NOTE2"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("NR"),
        },
        "water_pump": {"underground_static_tank_l": "NR", "terrace_tank_l": "2500_plus_2500_if_basement_gt_200", "pump_near_underground_tank": "NR", "pump_at_terrace_lpm": "NR"},
    },
    {
        "id": "C1_lt15_plot_upto_1000_gplus1_with_beds",
        "occupancy_subtype": "C1_hospital_nursing_home",
        "category": "C-1 Hospital / Nursing Home",
        "conditions": {"height_lt": 15, "plot_area_lte": 1000, "above_ground_storeys_lte": 2, "beds_present": True},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("NR"), "downcomer": _raw("R"), "yard_hydrant": _raw("NR"),
            "auto_sprinkler": _cond("NOTE2"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("NR"),
        },
        "water_pump": {"underground_static_tank_l": "NR", "terrace_tank_l": "5000_plus_5000_if_basement_gt_200", "pump_near_underground_tank": "NR", "pump_at_terrace_lpm": "450_plus_450_if_basement_gt_200"},
    },
    {
        "id": "C1_lt15_plot_upto_1000_gt_gplus1_no_beds",
        "occupancy_subtype": "C1_hospital_nursing_home",
        "category": "C-1 Hospital / Nursing Home",
        "conditions": {"height_lt": 15, "plot_area_lte": 1000, "above_ground_storeys_gt": 2, "beds_present": False},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("NR"), "downcomer": _raw("R"), "yard_hydrant": _raw("NR"),
            "auto_sprinkler": _cond("NOTE2"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "NR", "terrace_tank_l": "5000_plus_5000_if_basement_gt_200", "pump_near_underground_tank": "NR", "pump_at_terrace_lpm": "450_plus_450_if_basement_gt_200"},
    },
    {
        "id": "C1_lt15_plot_upto_1000_gt_gplus1_with_beds",
        "occupancy_subtype": "C1_hospital_nursing_home",
        "category": "C-1 Hospital / Nursing Home",
        "conditions": {"height_lt": 15, "plot_area_lte": 1000, "above_ground_storeys_gt": 2, "beds_present": True},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("R"), "downcomer": _raw("NR"), "yard_hydrant": _raw("NR"),
            "auto_sprinkler": _cond("NOTE2"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "50000", "terrace_tank_l": "5000_plus_5000_if_basement_gt_200", "pump_near_underground_tank": "as_per_note_19", "pump_at_terrace_lpm": "NR"},
    },
    {
        "id": "C1_lt15_plot_gt_1000",
        "occupancy_subtype": "C1_hospital_nursing_home",
        "category": "C-1 Hospital / Nursing Home",
        "conditions": {"height_lt": 15, "plot_area_gt": 1000},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("R"), "downcomer": _raw("NR"), "yard_hydrant": _raw("R"),
            "auto_sprinkler": _cond("NOTE2"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "100000", "terrace_tank_l": "10000", "pump_near_underground_tank": "as_per_note_19", "pump_at_terrace_lpm": "NR"},
    },
    {
        "id": "C1_15_to_24",
        "occupancy_subtype": "C1_hospital_nursing_home",
        "category": "C-1 Hospital / Nursing Home",
        "conditions": {"height_gte": 15, "height_lte": 24},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("R"), "downcomer": _raw("NR"), "yard_hydrant": _raw("R"),
            "auto_sprinkler": _cond("NOTE11"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "100000", "terrace_tank_l": "20000", "pump_near_underground_tank": "as_per_note_20", "pump_at_terrace_lpm": "NR"},
    },
    {
        "id": "C1_gt24_to_30",
        "occupancy_subtype": "C1_hospital_nursing_home",
        "category": "C-1 Hospital / Nursing Home",
        "conditions": {"height_gt": 24, "height_lte": 30},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("R"), "downcomer": _raw("NR"), "yard_hydrant": _raw("R"),
            "auto_sprinkler": _cond("NOTE11"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "150000", "terrace_tank_l": "20000", "pump_near_underground_tank": "as_per_note_21", "pump_at_terrace_lpm": "NR"},
    },
    {
        "id": "C23_lt10_upto300",
        "occupancy_subtype": ["C2_custodial", "C3_penal_mental"],
        "category": "C-2 / C-3 Custodial / Penal / Mental",
        "conditions": {"height_lt": 10, "occupant_load_lte": 300},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("NR"), "downcomer": _raw("NR"), "yard_hydrant": _raw("NR"),
            "auto_sprinkler": _cond("NOTE2"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("NR"),
        },
        "water_pump": {"underground_static_tank_l": "NR", "terrace_tank_l": "10000_plus_5000_if_basement_gt_200", "pump_near_underground_tank": "NR", "pump_at_terrace_lpm": "450_(900)_see_note4"},
    },
    {
        "id": "C23_lt10_more_than_300",
        "occupancy_subtype": ["C2_custodial", "C3_penal_mental"],
        "category": "C-2 / C-3 Custodial / Penal / Mental",
        "conditions": {"height_lt": 10, "occupant_load_gt": 300},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("NR"), "downcomer": _raw("R"), "yard_hydrant": _raw("NR"),
            "auto_sprinkler": _cond("NOTE2"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("NR"),
        },
        "water_pump": {"underground_static_tank_l": "NR", "terrace_tank_l": "15000_plus_5000_if_basement_gt_200", "pump_near_underground_tank": "NR", "pump_at_terrace_lpm": "450_(900)_see_note4"},
    },
    {
        "id": "C23_10_to_15",
        "occupancy_subtype": ["C2_custodial", "C3_penal_mental"],
        "category": "C-2 / C-3 Custodial / Penal / Mental",
        "conditions": {"height_gte": 10, "height_lte": 15},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("R"), "downcomer": _raw("NR"), "yard_hydrant": _raw("R"),
            "auto_sprinkler": _cond("NOTE2"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "50000", "terrace_tank_l": "5000_plus_5000_if_basement_gt_200", "pump_near_underground_tank": "as_per_note_20", "pump_at_terrace_lpm": "NR"},
    },
    {
        "id": "C23_15_to_24",
        "occupancy_subtype": ["C2_custodial", "C3_penal_mental"],
        "category": "C-2 / C-3 Custodial / Penal / Mental",
        "conditions": {"height_gt": 15, "height_lte": 24},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("R"), "downcomer": _raw("NR"), "yard_hydrant": _raw("R"),
            "auto_sprinkler": _cond("NOTE11"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "75000", "terrace_tank_l": "10000", "pump_near_underground_tank": "as_per_note_20", "pump_at_terrace_lpm": "NR"},
    },
    {
        "id": "C23_24_to_30",
        "occupancy_subtype": ["C2_custodial", "C3_penal_mental"],
        "category": "C-2 / C-3 Custodial / Penal / Mental",
        "conditions": {"height_gte": 24, "height_lte": 30},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("R"), "downcomer": _raw("NR"), "yard_hydrant": _raw("R"),
            "auto_sprinkler": _cond("NOTE11"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "100000", "terrace_tank_l": "20000", "pump_near_underground_tank": "as_per_note_21", "pump_at_terrace_lpm": "NR"},
    },
    # D - Assembly
    {
        "id": "D1_5_lt10_upto300",
        "occupancy_subtype": "D1_D5_assembly",
        "category": "D-1 to D-5 Assembly Building",
        "conditions": {"height_lt": 10, "occupant_load_lte": 300},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("NR"), "downcomer": _raw("R"), "yard_hydrant": _raw("NR"),
            "auto_sprinkler": _cond("NOTE2"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("NR"),
        },
        "water_pump": {"underground_static_tank_l": "NR", "terrace_tank_l": "10000_plus_5000_if_basement_gt_200", "pump_near_underground_tank": "NR", "pump_at_terrace_lpm": "450_plus_450_if_basement_gt_200"},
    },
    {
        "id": "D1_5_lt10_gt300",
        "occupancy_subtype": "D1_D5_assembly",
        "category": "D-1 to D-5 Assembly Building",
        "conditions": {"height_lt": 10, "occupant_load_gt": 300},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("NR"), "downcomer": _raw("R"), "yard_hydrant": _raw("NR"),
            "auto_sprinkler": _cond("NOTE2"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("NR"),
        },
        "water_pump": {"underground_static_tank_l": "NR", "terrace_tank_l": "15000_plus_5000_if_basement_gt_200", "pump_near_underground_tank": "NR", "pump_at_terrace_lpm": "900"},
    },
    {
        "id": "D1_5_10_to_15",
        "occupancy_subtype": "D1_D5_assembly",
        "category": "D-1 to D-5 Assembly Building",
        "conditions": {"height_gt": 10, "height_lte": 15},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("R"), "downcomer": _raw("NR"), "yard_hydrant": _raw("NR"),
            "auto_sprinkler": _cond("NOTE2"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "50000", "terrace_tank_l": "5000_plus_5000_if_basement_gt_200", "pump_near_underground_tank": "as_per_note_20", "pump_at_terrace_lpm": "450_plus_450_if_basement_gt_200"},
    },
    {
        "id": "D1_5_15_to_24",
        "occupancy_subtype": "D1_D5_assembly",
        "category": "D-1 to D-5 Assembly Building",
        "conditions": {"height_gt": 15, "height_lte": 24},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("R"), "downcomer": _raw("NR"), "yard_hydrant": _raw("R"),
            "auto_sprinkler": _cond("NOTE11"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "75000", "terrace_tank_l": "10000", "pump_near_underground_tank": "as_per_note_20", "pump_at_terrace_lpm": "NR"},
    },
    {
        "id": "D1_5_24_to_30",
        "occupancy_subtype": "D1_D5_assembly",
        "category": "D-1 to D-5 Assembly Building",
        "conditions": {"height_gt": 24, "height_lte": 30},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("R"), "downcomer": _raw("NR"), "yard_hydrant": _raw("R"),
            "auto_sprinkler": _cond("NOTE10"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "100000", "terrace_tank_l": "20000", "pump_near_underground_tank": "as_per_note_21", "pump_at_terrace_lpm": "NR"},
    },
    {
        "id": "D6_multiplex",
        "occupancy_subtype": "D6_multiplex",
        "category": "D-6 Multiplex",
        "conditions": {},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("R"), "downcomer": _raw("NR"), "yard_hydrant": _raw("R"),
            "auto_sprinkler": _cond("NOTE10"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "200000", "terrace_tank_l": "20000", "pump_near_underground_tank": "as_per_note_22", "pump_at_terrace_lpm": "NR"},
    },
    # E - Business
    {
        "id": "E_lt10",
        "occupancy_subtype": "E_business",
        "category": "E Business Building",
        "conditions": {"height_lt": 10},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("NR"), "downcomer": _raw("R"), "yard_hydrant": _raw("NR"),
            "auto_sprinkler": _cond("NOTE2"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("NR"),
        },
        "water_pump": {"underground_static_tank_l": "NR", "terrace_tank_l": "10000_plus_5000_if_basement_gt_200", "pump_near_underground_tank": "NR", "pump_at_terrace_lpm": "450_plus_450_if_basement_gt_200"},
    },
    {
        "id": "E_10_to_15",
        "occupancy_subtype": "E_business",
        "category": "E Business Building",
        "conditions": {"height_gt": 10, "height_lte": 15},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("R"), "downcomer": _raw("NR"), "yard_hydrant": _raw("NR"),
            "auto_sprinkler": _cond("NOTE2"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "50000", "terrace_tank_l": "5000_plus_5000_if_basement_gt_200", "pump_near_underground_tank": "as_per_note_20", "pump_at_terrace_lpm": "450_plus_450_if_basement_gt_200"},
    },
    {
        "id": "E_15_to_24",
        "occupancy_subtype": "E_business",
        "category": "E Business Building",
        "conditions": {"height_gt": 15, "height_lte": 24},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("R"), "downcomer": _raw("NR"), "yard_hydrant": _raw("R"),
            "auto_sprinkler": _cond("NOTE11"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "75000", "terrace_tank_l": "10000", "pump_near_underground_tank": "as_per_note_20", "pump_at_terrace_lpm": "NR"},
    },
    {
        "id": "E_24_to_30",
        "occupancy_subtype": "E_business",
        "category": "E Business Building",
        "conditions": {"height_gt": 24, "height_lte": 30},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("R"), "downcomer": _raw("NR"), "yard_hydrant": _raw("R"),
            "auto_sprinkler": _cond("NOTE10"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "100000", "terrace_tank_l": "20000", "pump_near_underground_tank": "as_per_note_21", "pump_at_terrace_lpm": "NR"},
    },
    {
        "id": "E_above_30",
        "occupancy_subtype": "E_business",
        "category": "E Business Building",
        "conditions": {"height_gt": 30},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("R"), "downcomer": _raw("NR"), "yard_hydrant": _raw("R"),
            "auto_sprinkler": _cond("NOTE10"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "200000", "terrace_tank_l": "20000", "pump_near_underground_tank": "as_per_note_22", "pump_at_terrace_lpm": "NR"},
    },
    # F - Mercantile
    {
        "id": "F12_lt15_gplus1_total_le_500",
        "occupancy_subtype": "F1_F2_mercantile",
        "category": "F-1 / F-2 Mercantile Building",
        "conditions": {"height_lt": 15, "above_ground_storeys_lte": 2, "total_covered_area_lte": 500},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("NR"), "downcomer": _raw("R"), "yard_hydrant": _raw("NR"),
            "auto_sprinkler": _cond("NOTE2"), "manual_fire_alarm": _raw("NR"), "auto_detection_alarm": _raw("NR"),
        },
        "water_pump": {"underground_static_tank_l": "NR", "terrace_tank_l": "5000_plus_5000_if_basement_gt_200", "pump_near_underground_tank": "NR", "pump_at_terrace_lpm": "450_plus_450_if_basement_gt_200"},
    },
    {
        "id": "F12_lt15_gplus1_total_gt_500",
        "occupancy_subtype": "F1_F2_mercantile",
        "category": "F-1 / F-2 Mercantile Building",
        "conditions": {"height_lt": 15, "above_ground_storeys_lte": 2, "total_covered_area_gt": 500},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("NR"), "downcomer": _raw("R"), "yard_hydrant": _raw("NR"),
            "auto_sprinkler": _cond("NOTE2"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("NR"),
        },
        "water_pump": {"underground_static_tank_l": "NR", "terrace_tank_l": "25000", "pump_near_underground_tank": "NR", "pump_at_terrace_lpm": "900"},
    },
    {
        "id": "F12_lt15_more_than_gplus1",
        "occupancy_subtype": "F1_F2_mercantile",
        "category": "F-1 / F-2 Mercantile Building",
        "conditions": {"height_lt": 15, "above_ground_storeys_gt": 2},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("R"),
            "wet_riser": _raw("NR"), "downcomer": _raw("R"), "yard_hydrant": _raw("NR"),
            "auto_sprinkler": _cond("NOTE2"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("NR"),
        },
        "water_pump": {"underground_static_tank_l": "NR", "terrace_tank_l": "5000_plus_5000_if_basement_gt_200", "pump_near_underground_tank": "NR", "pump_at_terrace_lpm": "900"},
    },
    {
        "id": "F12_15_to_24",
        "occupancy_subtype": "F1_F2_mercantile",
        "category": "F-1 / F-2 Mercantile Building",
        "conditions": {"height_gt": 15, "height_lte": 24},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("R"), "downcomer": _raw("NR"), "yard_hydrant": _raw("NR"),
            "auto_sprinkler": _cond("NOTE11"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "100000", "terrace_tank_l": "10000", "pump_near_underground_tank": "as_per_note_20", "pump_at_terrace_lpm": "NR"},
    },
    {
        "id": "F12_24_to_30",
        "occupancy_subtype": "F1_F2_mercantile",
        "category": "F-1 / F-2 Mercantile Building",
        "conditions": {"height_gt": 24, "height_lte": 30},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("R"), "downcomer": _raw("NR"), "yard_hydrant": _raw("R"),
            "auto_sprinkler": _cond("NOTE10"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "150000", "terrace_tank_l": "10000", "pump_near_underground_tank": "as_per_note_21", "pump_at_terrace_lpm": "NR"},
    },
    {
        "id": "F3_underground_shopping",
        "occupancy_subtype": "F3_underground_shopping",
        "category": "F-3 Underground Shopping Complex",
        "conditions": {},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("R"), "downcomer": _raw("NR"), "yard_hydrant": _raw("R"),
            "auto_sprinkler": _cond("NOTE10"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "150000", "terrace_tank_l": "10000", "pump_near_underground_tank": "as_per_note_21", "pump_at_terrace_lpm": "NR"},
    },
    # G - Industrial
    {
        "id": "G1_upto_100",
        "occupancy_subtype": "G1_low_hazard_industrial",
        "category": "G-1 Low Hazard Industrial",
        "conditions": {"built_up_area_lte": 100},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("NR"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("NR"), "downcomer": _raw("NR"), "yard_hydrant": _raw("NR"),
            "auto_sprinkler": _cond("NOTE2"), "manual_fire_alarm": _raw("NR"), "auto_detection_alarm": _raw("NR"),
        },
        "water_pump": {"underground_static_tank_l": "NR", "terrace_tank_l": "5000_if_basement_gt_200", "pump_near_underground_tank": "NR", "pump_at_terrace_lpm": "450_if_basement_gt_200"},
    },
    {
        "id": "G1_100_to_500",
        "occupancy_subtype": "G1_low_hazard_industrial",
        "category": "G-1 Low Hazard Industrial",
        "conditions": {"built_up_area_gt": 100, "built_up_area_lte": 500},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("NR"), "downcomer": _raw("R"), "yard_hydrant": _raw("NR"),
            "auto_sprinkler": _cond("NOTE2"), "manual_fire_alarm": _raw("NR"), "auto_detection_alarm": _raw("NR"),
        },
        "water_pump": {"underground_static_tank_l": "NR", "terrace_tank_l": "5000_plus_5000_if_basement_gt_200", "pump_near_underground_tank": "NR", "pump_at_terrace_lpm": "450"},
    },
    {
        "id": "G1_more_than_500",
        "occupancy_subtype": "G1_low_hazard_industrial",
        "category": "G-1 Low Hazard Industrial",
        "conditions": {"built_up_area_gt": 500},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _cond("NOTE7"), "downcomer": _raw("R"), "yard_hydrant": _raw("R"),
            "auto_sprinkler": _raw("R"), "manual_fire_alarm": _raw("NR"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "100000", "terrace_tank_l": "10000", "pump_near_underground_tank": "as_per_note_20", "pump_at_terrace_lpm": "450"},
    },
    {
        "id": "G2_upto_100",
        "occupancy_subtype": "G2_moderate_hazard_industrial",
        "category": "G-2 Moderate Hazard Industrial",
        "conditions": {"built_up_area_lte": 100},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("NR"), "downcomer": _raw("NR"), "yard_hydrant": _raw("NR"),
            "auto_sprinkler": _raw("R"), "manual_fire_alarm": _raw("NR"), "auto_detection_alarm": _raw("NR"),
        },
        "water_pump": {"underground_static_tank_l": "NR", "terrace_tank_l": "10000", "pump_near_underground_tank": "NR", "pump_at_terrace_lpm": "450"},
    },
    {
        "id": "G2_100_to_500",
        "occupancy_subtype": "G2_moderate_hazard_industrial",
        "category": "G-2 Moderate Hazard Industrial",
        "conditions": {"built_up_area_gt": 100, "built_up_area_lte": 500},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("NR"), "downcomer": _raw("NR"), "yard_hydrant": _raw("NR"),
            "auto_sprinkler": _raw("R"), "manual_fire_alarm": _raw("NR"), "auto_detection_alarm": _raw("NR"),
        },
        "water_pump": {"underground_static_tank_l": "NR", "terrace_tank_l": "10000", "pump_near_underground_tank": "NR", "pump_at_terrace_lpm": "900"},
    },
    {
        "id": "G2_500_to_1000",
        "occupancy_subtype": "G2_moderate_hazard_industrial",
        "category": "G-2 Moderate Hazard Industrial",
        "conditions": {"built_up_area_gt": 500, "built_up_area_lte": 1000},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _cond("NOTE7"), "downcomer": _raw("R"), "yard_hydrant": _raw("R"),
            "auto_sprinkler": _raw("R"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "75000", "terrace_tank_l": "20000", "pump_near_underground_tank": "as_per_note_20", "pump_at_terrace_lpm": "900"},
    },
    {
        "id": "G2_more_than_1000",
        "occupancy_subtype": "G2_moderate_hazard_industrial",
        "category": "G-2 Moderate Hazard Industrial",
        "conditions": {"built_up_area_gt": 1000},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _cond("NOTE7"), "downcomer": _raw("R"), "yard_hydrant": _raw("R"),
            "auto_sprinkler": _raw("R"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "100000", "terrace_tank_l": "20000", "pump_near_underground_tank": "as_per_note_20", "pump_at_terrace_lpm": "900"},
    },
    {
        "id": "G3_upto_50",
        "occupancy_subtype": "G3_high_hazard_industrial",
        "category": "G-3 High Hazard Industrial",
        "conditions": {"built_up_area_lte": 50},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("NR"), "downcomer": _raw("NR"), "yard_hydrant": _raw("NR"),
            "auto_sprinkler": _raw("R"), "manual_fire_alarm": _raw("NR"), "auto_detection_alarm": _raw("NR"),
        },
        "water_pump": {"underground_static_tank_l": "NR", "terrace_tank_l": "5000", "pump_near_underground_tank": "NR", "pump_at_terrace_lpm": "450"},
    },
    {
        "id": "G3_50_to_150",
        "occupancy_subtype": "G3_high_hazard_industrial",
        "category": "G-3 High Hazard Industrial",
        "conditions": {"built_up_area_gt": 50, "built_up_area_lte": 150},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("NR"), "downcomer": _raw("NR"), "yard_hydrant": _raw("NR"),
            "auto_sprinkler": _raw("R"), "manual_fire_alarm": _raw("NR"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "NR", "terrace_tank_l": "5000", "pump_near_underground_tank": "NR", "pump_at_terrace_lpm": "450"},
    },
    {
        "id": "G3_150_to_300",
        "occupancy_subtype": "G3_high_hazard_industrial",
        "category": "G-3 High Hazard Industrial",
        "conditions": {"built_up_area_gt": 150, "built_up_area_lte": 300},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("R"), "downcomer": _raw("NR"), "yard_hydrant": _raw("NR"),
            "auto_sprinkler": _raw("R"), "manual_fire_alarm": _raw("NR"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "25000", "terrace_tank_l": "10000", "pump_near_underground_tank": "as_per_note_19", "pump_at_terrace_lpm": "450"},
    },
    {
        "id": "G3_300_to_500",
        "occupancy_subtype": "G3_high_hazard_industrial",
        "category": "G-3 High Hazard Industrial",
        "conditions": {"built_up_area_gt": 300, "built_up_area_lte": 500},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("R"), "downcomer": _raw("NR"), "yard_hydrant": _raw("R"),
            "auto_sprinkler": _raw("R"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "50000", "terrace_tank_l": "20000", "pump_near_underground_tank": "as_per_note_19", "pump_at_terrace_lpm": "900"},
    },
    {
        "id": "G3_more_than_500",
        "occupancy_subtype": "G3_high_hazard_industrial",
        "category": "G-3 High Hazard Industrial",
        "conditions": {"built_up_area_gt": 500},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _cond("NOTE7"), "downcomer": _raw("R"), "yard_hydrant": _raw("R"),
            "auto_sprinkler": _raw("R"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "100000", "terrace_tank_l": "20000", "pump_near_underground_tank": "as_per_note_20", "pump_at_terrace_lpm": "900"},
    },
    # H - Storage
    {
        "id": "H_lt15_area_lt250",
        "occupancy_subtype": "H_storage",
        "category": "H Storage Building",
        "conditions": {"height_lt": 15, "covered_area_lte": 250},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("NR"), "downcomer": _raw("NR"), "yard_hydrant": _raw("NR"),
            "auto_sprinkler": _raw("R"), "manual_fire_alarm": _raw("NR"), "auto_detection_alarm": _raw("NR"),
        },
        "water_pump": {"underground_static_tank_l": "25000", "terrace_tank_l": "5000", "pump_near_underground_tank": "as_per_note_19", "pump_at_terrace_lpm": "450"},
    },
    {
        "id": "H_lt15_area_gt250_ground_only",
        "occupancy_subtype": "H_storage",
        "category": "H Storage Building",
        "conditions": {"height_lt": 15, "covered_area_gt": 250, "above_ground_storeys_lte": 1},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("R"), "downcomer": _raw("NR"), "yard_hydrant": _raw("R"),
            "auto_sprinkler": _raw("R"), "manual_fire_alarm": _raw("NR"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "50000", "terrace_tank_l": "10000", "pump_near_underground_tank": "as_per_note_20", "pump_at_terrace_lpm": "450"},
    },
    {
        "id": "H_lt15_area_gt250_gplus1",
        "occupancy_subtype": "H_storage",
        "category": "H Storage Building",
        "conditions": {"height_lt": 15, "covered_area_gt": 250, "above_ground_storeys_eq": 2},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("R"), "downcomer": _raw("NR"), "yard_hydrant": _raw("R"),
            "auto_sprinkler": _raw("R"), "manual_fire_alarm": _raw("NR"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "75000", "terrace_tank_l": "10000", "pump_near_underground_tank": "as_per_note_20", "pump_at_terrace_lpm": "450"},
    },
    {
        "id": "H_lt15_area_gt250_more_than_gplus1",
        "occupancy_subtype": "H_storage",
        "category": "H Storage Building",
        "conditions": {"height_lt": 15, "covered_area_gt": 250, "above_ground_storeys_gt": 2},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("R"), "downcomer": _raw("NR"), "yard_hydrant": _raw("R"),
            "auto_sprinkler": _raw("R"), "manual_fire_alarm": _raw("NR"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "100000", "terrace_tank_l": "10000", "pump_near_underground_tank": "as_per_note_20", "pump_at_terrace_lpm": "450"},
    },
    # J - Hazardous
    {
        "id": "J_upto15_single_storey",
        "occupancy_subtype": "J_hazardous",
        "category": "J Hazardous Building",
        "conditions": {"height_lte": 15, "above_ground_storeys_lte": 1},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("NR"), "downcomer": _raw("NR"), "yard_hydrant": _raw("R"),
            "auto_sprinkler": _raw("R"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "minimum_4h_fire_fighting_requirements", "terrace_tank_l": "NR", "pump_near_underground_tank": "as_per_note_18", "pump_at_terrace_lpm": "NR"},
    },
    {
        "id": "J_upto15_more_than_one_floor",
        "occupancy_subtype": "J_hazardous",
        "category": "J Hazardous Building",
        "conditions": {"height_lte": 15, "above_ground_storeys_gt": 1},
        "equip": {
            "fire_extinguisher": _raw("R"), "hose_reel": _raw("R"), "dry_riser": _raw("NR"),
            "wet_riser": _raw("R"), "downcomer": _raw("R"), "yard_hydrant": _raw("R"),
            "auto_sprinkler": _raw("R"), "manual_fire_alarm": _raw("R"), "auto_detection_alarm": _raw("R"),
        },
        "water_pump": {"underground_static_tank_l": "minimum_4h_fire_fighting_requirements", "terrace_tank_l": "50000", "pump_near_underground_tank": "as_per_note_18", "pump_at_terrace_lpm": "900"},
    },
]


def _get(ans: Dict[str, Any], key: str, default: Any = None) -> Any:
    return ans.get(key, default)


def _matches_subtype(rule_subtype: Any, selected: str) -> bool:
    if isinstance(rule_subtype, list):
        return selected in rule_subtype
    return rule_subtype == selected


def _check_conditions(conditions: Dict[str, Any], ans: Dict[str, Any]) -> bool:
    valmap = {
        "height": _get(ans, "height_m", 0),
        "rooms": _get(ans, "rooms", 0),
        "above_ground_storeys": _get(ans, "above_ground_storeys", 0),
        "plot_area": _get(ans, "plot_area_m2", 0),
        "covered_area_per_floor": _get(ans, "covered_area_per_floor_m2", 0),
        "total_covered_area": _get(ans, "total_covered_area_m2", 0),
        "built_up_area": _get(ans, "built_up_area_m2", 0),
        "covered_area": _get(ans, "covered_area_m2", 0),
        "occupant_load": _get(ans, "occupant_load", 0),
        "beds_present": _get(ans, "beds_present", False),
    }

    for ck, cv in conditions.items():
        if ck == "height_lt" and not (valmap["height"] < cv): return False
        if ck == "height_lte" and not (valmap["height"] <= cv): return False
        if ck == "height_gt" and not (valmap["height"] > cv): return False
        if ck == "height_gte" and not (valmap["height"] >= cv): return False
        if ck == "rooms_lte" and not (valmap["rooms"] <= cv): return False
        if ck == "rooms_gt" and not (valmap["rooms"] > cv): return False
        if ck == "above_ground_storeys_lte" and not (valmap["above_ground_storeys"] <= cv): return False
        if ck == "above_ground_storeys_eq" and not (valmap["above_ground_storeys"] == cv): return False
        if ck == "above_ground_storeys_gt" and not (valmap["above_ground_storeys"] > cv): return False
        if ck == "plot_area_lte" and not (valmap["plot_area"] <= cv): return False
        if ck == "plot_area_gt" and not (valmap["plot_area"] > cv): return False
        if ck == "covered_area_per_floor_lte" and not (valmap["covered_area_per_floor"] <= cv): return False
        if ck == "covered_area_per_floor_gt" and not (valmap["covered_area_per_floor"] > cv): return False
        if ck == "total_covered_area_lte" and not (valmap["total_covered_area"] <= cv): return False
        if ck == "total_covered_area_gt" and not (valmap["total_covered_area"] > cv): return False
        if ck == "built_up_area_lte" and not (valmap["built_up_area"] <= cv): return False
        if ck == "built_up_area_gt" and not (valmap["built_up_area"] > cv): return False
        if ck == "covered_area_lte" and not (valmap["covered_area"] <= cv): return False
        if ck == "covered_area_gt" and not (valmap["covered_area"] > cv): return False
        if ck == "occupant_load_lte" and not (valmap["occupant_load"] <= cv): return False
        if ck == "occupant_load_gt" and not (valmap["occupant_load"] > cv): return False
        if ck == "beds_present" and not (valmap["beds_present"] == cv): return False
    return True


def _evaluate_conditional_codes(codes: List[str], ans: Dict[str, Any]) -> Tuple[bool, List[str]]:
    notes: List[str] = []
    required = True
    for code in codes:
        if code == "NOTE2":
            if _get(ans, "basement_area_m2", 0) > 200:
                notes.append(NOTES[2])
            else:
                required = False
        elif code == "NOTE5":
            if _get(ans, "above_ground_storeys", 0) > 2:
                notes.append(NOTES[5])
            else:
                required = False
        elif code == "NOTE7":
            if _get(ans, "height_m", 0) > 15:
                notes.append(NOTES[7])
            else:
                required = False
        elif code == "NOTE8":
            notes.append(NOTES[8])
        elif code == "NOTE9":
            if _get(ans, "above_ground_storeys", 0) > 1:
                notes.append(NOTES[9])
            else:
                required = False
        elif code == "NOTE10":
            notes.append(NOTES[10])
        elif code == "NOTE11":
            notes.append(NOTES[11])
        else:
            notes.append(code)
    return required, notes


def _resolve_equipment(value_obj: Dict[str, Any], ans: Dict[str, Any]) -> Tuple[bool, List[str]]:
    if value_obj["type"] == "raw":
        return (True, []) if value_obj["value"] == "R" else (False, [])
    if value_obj["type"] == "conditional":
        return _evaluate_conditional_codes(value_obj["codes"], ans)
    raise ValueError(f"Unknown value object: {value_obj}")


def compliance_warnings(ans: Dict[str, Any]) -> List[str]:
    subtype = ans["occupancy_subtype"]
    height = _get(ans, "height_m", 0)
    warnings: List[str] = []
    if subtype in {"A1_lodging_rooming_house", "A2_private_dwelling"} and height > 15:
        warnings.append(NOTES[1])
    if subtype in {
        "B_educational", "C1_hospital_nursing_home", "C2_custodial", "C3_penal_mental",
        "D1_D5_assembly", "D6_multiplex", "D7_special_assembly",
        "F1_F2_mercantile", "F3_underground_shopping",
    } and height > 30:
        warnings.append(NOTES[12])
    if subtype in {"G1_low_hazard_industrial", "G2_moderate_hazard_industrial"} and height > 18:
        warnings.append(NOTES[15])
    if subtype == "G3_high_hazard_industrial" and height > 15:
        warnings.append(NOTES[16])
    if subtype in {"H_storage", "J_hazardous"} and height > 15:
        warnings.append(NOTES[17])
    if subtype in {"G1_low_hazard_industrial", "G2_moderate_hazard_industrial", "G3_high_hazard_industrial"}:
        if not _get(ans, "small_scale_industry", False):
            warnings.append(NOTES[14])
    if subtype == "F3_underground_shopping":
        warnings.append(NOTES[13])
    if subtype == "D7_special_assembly":
        warnings.append("D-7 cannot be resolved from Table 23 alone; Table 23 itself says: 'For details see 6.4.8'.")
    return warnings


def find_rule(ans: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    subtype = ans["occupancy_subtype"]
    if subtype == "D7_special_assembly":
        return None
    for rule in RULES:
        if not _matches_subtype(rule["occupancy_subtype"], subtype):
            continue
        if _check_conditions(rule["conditions"], ans):
            return rule
    return None


def evaluate_building(ans: Dict[str, Any]) -> Dict[str, Any]:
    warnings = compliance_warnings(ans)
    rule = find_rule(ans)

    if rule is None:
        return {
            "matched_rule_id": None,
            "matched_category": None,
            "equipment": [],
            "warnings": warnings or ["No Table 23 rule matched with the supplied answers."],
        }

    equipment: List[Dict[str, Any]] = []
    for key, value_obj in rule["equip"].items():
        is_required, notes = _resolve_equipment(value_obj, ans)
        supported = key in SUPPORTED_EQUIPMENT
        equipment.append({
            "key": key,
            "label": EQUIPMENT_LABELS[key],
            "required": is_required,
            "supported": supported,
            "notes": notes,
        })

    if _get(ans, "height_m", 0) > 45:
        sprinkler_items = [e for e in equipment if e["key"] == "auto_sprinkler" and e["required"]]
        if sprinkler_items:
            warnings.append(NOTES[23])

    return {
        "matched_rule_id": rule["id"],
        "matched_category": rule["category"],
        "equipment": equipment,
        "water_pump_requirements": rule["water_pump"],
        "warnings": warnings,
    }
