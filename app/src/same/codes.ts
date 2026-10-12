// SAME (Specific Area Message Encoding) code tables: originators, event codes (47 CFR 11.31 +
// NWS NWR additions), state / marine area numbers, and part-of-area digits.

export const ORIGINATORS: Record<string, string> = {
  WXR: "National Weather Service",
  EAS: "EAS participant (broadcast/cable)",
  CIV: "Civil authorities",
  PEP: "Primary Entry Point (national)",
  EAN: "Emergency Action Notification Network",
};

export type EventLevel = "emergency" | "warning" | "watch" | "advisory" | "statement" | "test" | "admin";

/** code → [name, level] */
export const EVENTS: Record<string, [string, EventLevel]> = {
  // national
  EAN: ["Emergency Action Notification", "emergency"],
  EAT: ["Emergency Action Termination", "admin"],
  NIC: ["National Information Center", "statement"],
  NPT: ["National Periodic Test", "test"],
  NAT: ["National Audible Test", "test"],
  NST: ["National Silent Test", "test"],
  NMN: ["Network Message Notification", "admin"],
  RMT: ["Required Monthly Test", "test"],
  RWT: ["Required Weekly Test", "test"],
  DMO: ["Practice/Demo Warning", "test"],
  ADR: ["Administrative Message", "admin"],
  // weather
  AVA: ["Avalanche Watch", "watch"],
  AVW: ["Avalanche Warning", "warning"],
  BZW: ["Blizzard Warning", "warning"],
  CFA: ["Coastal Flood Watch", "watch"],
  CFW: ["Coastal Flood Warning", "warning"],
  DSW: ["Dust Storm Warning", "warning"],
  EWW: ["Extreme Wind Warning", "warning"],
  FFA: ["Flash Flood Watch", "watch"],
  FFW: ["Flash Flood Warning", "warning"],
  FFS: ["Flash Flood Statement", "statement"],
  FLA: ["Flood Watch", "watch"],
  FLW: ["Flood Warning", "warning"],
  FLS: ["Flood Statement", "statement"],
  FSW: ["Flash Freeze Warning", "warning"],
  FZW: ["Freeze Warning", "warning"],
  HWA: ["High Wind Watch", "watch"],
  HWW: ["High Wind Warning", "warning"],
  HUA: ["Hurricane Watch", "watch"],
  HUW: ["Hurricane Warning", "warning"],
  HLS: ["Hurricane Statement", "statement"],
  SMW: ["Special Marine Warning", "warning"],
  SPS: ["Special Weather Statement", "statement"],
  SQW: ["Snow Squall Warning", "warning"],
  SSA: ["Storm Surge Watch", "watch"],
  SSW: ["Storm Surge Warning", "warning"],
  SVA: ["Severe Thunderstorm Watch", "watch"],
  SVR: ["Severe Thunderstorm Warning", "warning"],
  SVS: ["Severe Weather Statement", "statement"],
  TOA: ["Tornado Watch", "watch"],
  TOR: ["Tornado Warning", "warning"],
  TRA: ["Tropical Storm Watch", "watch"],
  TRW: ["Tropical Storm Warning", "warning"],
  TSA: ["Tsunami Watch", "watch"],
  TSW: ["Tsunami Warning", "warning"],
  WSA: ["Winter Storm Watch", "watch"],
  WSW: ["Winter Storm Warning", "warning"],
  // non-weather
  BHW: ["Biological Hazard Warning", "warning"],
  BLU: ["Blue Alert", "warning"],
  BWW: ["Boil Water Warning", "warning"],
  CAE: ["Child Abduction Emergency", "emergency"],
  CDW: ["Civil Danger Warning", "warning"],
  CEM: ["Civil Emergency Message", "emergency"],
  CHW: ["Chemical Hazard Warning", "warning"],
  CWW: ["Contaminated Water Warning", "warning"],
  DBA: ["Dam Watch", "watch"],
  DBW: ["Dam Break Warning", "warning"],
  EQW: ["Earthquake Warning", "warning"],
  EVA: ["Evacuation Watch", "watch"],
  EVI: ["Evacuation Immediate", "emergency"],
  FCW: ["Food Contamination Warning", "warning"],
  FRW: ["Fire Warning", "warning"],
  HMW: ["Hazardous Materials Warning", "warning"],
  IBW: ["Iceberg Warning", "warning"],
  IFW: ["Industrial Fire Warning", "warning"],
  LAE: ["Local Area Emergency", "emergency"],
  LEW: ["Law Enforcement Warning", "warning"],
  LSW: ["Land Slide Warning", "warning"],
  MEP: ["Missing and Endangered Persons", "warning"],
  NUW: ["Nuclear Power Plant Warning", "warning"],
  POS: ["Power Outage Statement", "statement"],
  RHW: ["Radiological Hazard Warning", "warning"],
  SPW: ["Shelter in Place Warning", "warning"],
  TOE: ["911 Telephone Outage Emergency", "emergency"],
  VOW: ["Volcano Warning", "warning"],
  WFA: ["Wild Fire Watch", "watch"],
  WFW: ["Wild Fire Warning", "warning"],
  // NWR transmitter status
  TXB: ["Transmitter Backup On", "admin"],
  TXF: ["Transmitter Carrier Off", "admin"],
  TXO: ["Transmitter Carrier On", "admin"],
  TXP: ["Transmitter Primary On", "admin"],
};

export function eventInfo(code: string): { name: string; level: EventLevel } {
  const e = EVENTS[code];
  if (e) return { name: e[0], level: e[1] };
  // unknown codes: the last letter follows the FCC convention
  const l = code[2];
  const level: EventLevel = l === "W" ? "warning" : l === "A" ? "watch" : l === "E" ? "emergency" : l === "S" ? "statement" : l === "T" ? "test" : "advisory";
  const kind = { warning: "Warning", watch: "Watch", emergency: "Emergency", statement: "Statement", test: "Test", advisory: "Message", admin: "Message" }[level];
  return { name: `Unknown event (${code}) ${kind}`, level };
}

export const PART: Record<string, string> = {
  "0": "",
  "1": "Northwest",
  "2": "North",
  "3": "Northeast",
  "4": "West",
  "5": "Central",
  "6": "East",
  "7": "Southwest",
  "8": "South",
  "9": "Southeast",
};

/** state FIPS → [abbr, name] */
export const STATES: Record<string, [string, string]> = {
  "01": ["AL", "Alabama"], "02": ["AK", "Alaska"], "04": ["AZ", "Arizona"], "05": ["AR", "Arkansas"], "06": ["CA", "California"],
  "08": ["CO", "Colorado"], "09": ["CT", "Connecticut"], "10": ["DE", "Delaware"], "11": ["DC", "District of Columbia"], "12": ["FL", "Florida"],
  "13": ["GA", "Georgia"], "15": ["HI", "Hawaii"], "16": ["ID", "Idaho"], "17": ["IL", "Illinois"], "18": ["IN", "Indiana"],
  "19": ["IA", "Iowa"], "20": ["KS", "Kansas"], "21": ["KY", "Kentucky"], "22": ["LA", "Louisiana"], "23": ["ME", "Maine"],
  "24": ["MD", "Maryland"], "25": ["MA", "Massachusetts"], "26": ["MI", "Michigan"], "27": ["MN", "Minnesota"], "28": ["MS", "Mississippi"],
  "29": ["MO", "Missouri"], "30": ["MT", "Montana"], "31": ["NE", "Nebraska"], "32": ["NV", "Nevada"], "33": ["NH", "New Hampshire"],
  "34": ["NJ", "New Jersey"], "35": ["NM", "New Mexico"], "36": ["NY", "New York"], "37": ["NC", "North Carolina"], "38": ["ND", "North Dakota"],
  "39": ["OH", "Ohio"], "40": ["OK", "Oklahoma"], "41": ["OR", "Oregon"], "42": ["PA", "Pennsylvania"], "44": ["RI", "Rhode Island"],
  "45": ["SC", "South Carolina"], "46": ["SD", "South Dakota"], "47": ["TN", "Tennessee"], "48": ["TX", "Texas"], "49": ["UT", "Utah"],
  "50": ["VT", "Vermont"], "51": ["VA", "Virginia"], "53": ["WA", "Washington"], "54": ["WV", "West Virginia"], "55": ["WI", "Wisconsin"],
  "56": ["WY", "Wyoming"], "60": ["AS", "American Samoa"], "66": ["GU", "Guam"], "69": ["MP", "Northern Mariana Islands"],
  "72": ["PR", "Puerto Rico"], "78": ["VI", "U.S. Virgin Islands"],
};

/** SAME marine "state" numbers (CCC is then the NWS marine zone number). */
export const MARINE: Record<string, string> = {
  "57": "Eastern North Pacific (PZ)",
  "58": "North Pacific near Alaska (PK)",
  "59": "Central Pacific / Hawaii (PH)",
  "61": "South Central Pacific (PS)",
  "65": "Western Pacific (PM)",
  "73": "Western North Atlantic (AN)",
  "75": "Western Atlantic incl. Caribbean (AM)",
  "77": "Gulf of America (GM)",
  "91": "Lake Superior (LS)",
  "92": "Lake Michigan (LM)",
  "93": "Lake Huron (LH)",
  "94": "Lake St. Clair (LC)",
  "96": "Lake Erie (LE)",
  "97": "Lake Ontario (LO)",
  "98": "St. Lawrence River (SL)",
};

/** County-equivalents newer than the bundled boundary data (us-atlas, 2017). */
export const EXTRA_COUNTIES: Record<string, string> = {
  "02063": "Chugach",
  "02066": "Copper River",
  "02158": "Kusilvak",
  "46102": "Oglala Lakota",
  "09110": "Capitol Planning Region",
  "09120": "Greater Bridgeport Planning Region",
  "09130": "Lower Connecticut River Valley Planning Region",
  "09140": "Naugatuck Valley Planning Region",
  "09150": "Northeastern Connecticut Planning Region",
  "09160": "Northwest Hills Planning Region",
  "09170": "South Central Connecticut Planning Region",
  "09180": "Southeastern Connecticut Planning Region",
  "09190": "Western Connecticut Planning Region",
};
