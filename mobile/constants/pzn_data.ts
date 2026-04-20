/**
 * Representative local PZN dataset for doctor medication search.
 *
 * Note: This is a bundled representative set (not a full ABDA database),
 * covering common prescribed classes in Germany.
 */

export interface PZNEntry {
  pzn: string;
  trade_name: string;
  active_substance: string;
  form: string;
  strength: string;
  norm_size: 'N1' | 'N2' | 'N3';
  dosage_unit: string;
}

export const PZN_DATA: PZNEntry[] = [
  {
    "pzn": "10000001",
    "trade_name": "Ramipril HEXAL",
    "active_substance": "Ramipril",
    "form": "Tablette",
    "strength": "2.5 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000002",
    "trade_name": "Ramipril HEXAL",
    "active_substance": "Ramipril",
    "form": "Tablette",
    "strength": "5 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000003",
    "trade_name": "Ramipril HEXAL",
    "active_substance": "Ramipril",
    "form": "Tablette",
    "strength": "10 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000004",
    "trade_name": "Candesartan-ratiopharm",
    "active_substance": "Candesartan",
    "form": "Tablette",
    "strength": "8 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000005",
    "trade_name": "Candesartan-ratiopharm",
    "active_substance": "Candesartan",
    "form": "Tablette",
    "strength": "16 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000006",
    "trade_name": "Candesartan-ratiopharm",
    "active_substance": "Candesartan",
    "form": "Tablette",
    "strength": "32 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000007",
    "trade_name": "Valsartan AL",
    "active_substance": "Valsartan",
    "form": "Filmtablette",
    "strength": "80 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000008",
    "trade_name": "Valsartan AL",
    "active_substance": "Valsartan",
    "form": "Filmtablette",
    "strength": "160 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000009",
    "trade_name": "Amlodipin STADA",
    "active_substance": "Amlodipin",
    "form": "Tablette",
    "strength": "5 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000010",
    "trade_name": "Amlodipin STADA",
    "active_substance": "Amlodipin",
    "form": "Tablette",
    "strength": "10 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000011",
    "trade_name": "Lercanidipin-ratiopharm",
    "active_substance": "Lercanidipin",
    "form": "Filmtablette",
    "strength": "10 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000012",
    "trade_name": "Lercanidipin-ratiopharm",
    "active_substance": "Lercanidipin",
    "form": "Filmtablette",
    "strength": "20 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000013",
    "trade_name": "Bisoprolol-ratiopharm",
    "active_substance": "Bisoprolol",
    "form": "Filmtablette",
    "strength": "2.5 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000014",
    "trade_name": "Bisoprolol-ratiopharm",
    "active_substance": "Bisoprolol",
    "form": "Filmtablette",
    "strength": "5 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000015",
    "trade_name": "Bisoprolol-ratiopharm",
    "active_substance": "Bisoprolol",
    "form": "Filmtablette",
    "strength": "10 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000016",
    "trade_name": "Metoprolol succinat-ratiopharm",
    "active_substance": "Metoprolol",
    "form": "Retardtablette",
    "strength": "47.5 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000017",
    "trade_name": "Metoprolol succinat-ratiopharm",
    "active_substance": "Metoprolol",
    "form": "Retardtablette",
    "strength": "95 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000018",
    "trade_name": "Nebivolol HEXAL",
    "active_substance": "Nebivolol",
    "form": "Tablette",
    "strength": "5 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000019",
    "trade_name": "Atorvastatin-ratiopharm",
    "active_substance": "Atorvastatin",
    "form": "Filmtablette",
    "strength": "10 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000020",
    "trade_name": "Atorvastatin-ratiopharm",
    "active_substance": "Atorvastatin",
    "form": "Filmtablette",
    "strength": "20 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000021",
    "trade_name": "Atorvastatin-ratiopharm",
    "active_substance": "Atorvastatin",
    "form": "Filmtablette",
    "strength": "40 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000022",
    "trade_name": "Simvastatin AL",
    "active_substance": "Simvastatin",
    "form": "Filmtablette",
    "strength": "20 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000023",
    "trade_name": "Simvastatin AL",
    "active_substance": "Simvastatin",
    "form": "Filmtablette",
    "strength": "40 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000024",
    "trade_name": "Rosuvastatin HEXAL",
    "active_substance": "Rosuvastatin",
    "form": "Filmtablette",
    "strength": "5 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000025",
    "trade_name": "Rosuvastatin HEXAL",
    "active_substance": "Rosuvastatin",
    "form": "Filmtablette",
    "strength": "10 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000026",
    "trade_name": "Rosuvastatin HEXAL",
    "active_substance": "Rosuvastatin",
    "form": "Filmtablette",
    "strength": "20 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000027",
    "trade_name": "Metformin HEXAL",
    "active_substance": "Metformin",
    "form": "Filmtablette",
    "strength": "500 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000028",
    "trade_name": "Metformin HEXAL",
    "active_substance": "Metformin",
    "form": "Filmtablette",
    "strength": "850 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000029",
    "trade_name": "Metformin HEXAL",
    "active_substance": "Metformin",
    "form": "Filmtablette",
    "strength": "1000 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000030",
    "trade_name": "Jardiance",
    "active_substance": "Empagliflozin",
    "form": "Filmtablette",
    "strength": "10 mg",
    "norm_size": "N2",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000031",
    "trade_name": "Jardiance",
    "active_substance": "Empagliflozin",
    "form": "Filmtablette",
    "strength": "25 mg",
    "norm_size": "N2",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000032",
    "trade_name": "Forxiga",
    "active_substance": "Dapagliflozin",
    "form": "Filmtablette",
    "strength": "10 mg",
    "norm_size": "N2",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000033",
    "trade_name": "Januvia",
    "active_substance": "Sitagliptin",
    "form": "Filmtablette",
    "strength": "50 mg",
    "norm_size": "N2",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000034",
    "trade_name": "Januvia",
    "active_substance": "Sitagliptin",
    "form": "Filmtablette",
    "strength": "100 mg",
    "norm_size": "N2",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000035",
    "trade_name": "Amaryl",
    "active_substance": "Glimepirid",
    "form": "Tablette",
    "strength": "2 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000036",
    "trade_name": "Amaryl",
    "active_substance": "Glimepirid",
    "form": "Tablette",
    "strength": "4 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000037",
    "trade_name": "Pantoprazol AL",
    "active_substance": "Pantoprazol",
    "form": "Magensaftresistente Tablette",
    "strength": "20 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000038",
    "trade_name": "Pantoprazol AL",
    "active_substance": "Pantoprazol",
    "form": "Magensaftresistente Tablette",
    "strength": "40 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000039",
    "trade_name": "Omeprazol-ratiopharm",
    "active_substance": "Omeprazol",
    "form": "Magensaftresistente Kapsel",
    "strength": "20 mg",
    "norm_size": "N3",
    "dosage_unit": "Kapsel"
  },
  {
    "pzn": "10000040",
    "trade_name": "Omeprazol-ratiopharm",
    "active_substance": "Omeprazol",
    "form": "Magensaftresistente Kapsel",
    "strength": "40 mg",
    "norm_size": "N3",
    "dosage_unit": "Kapsel"
  },
  {
    "pzn": "10000041",
    "trade_name": "Esomeprazol HEXAL",
    "active_substance": "Esomeprazol",
    "form": "Magensaftresistente Tablette",
    "strength": "20 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000042",
    "trade_name": "Esomeprazol HEXAL",
    "active_substance": "Esomeprazol",
    "form": "Magensaftresistente Tablette",
    "strength": "40 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000043",
    "trade_name": "Sertralin-1A Pharma",
    "active_substance": "Sertralin",
    "form": "Filmtablette",
    "strength": "50 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000044",
    "trade_name": "Sertralin-1A Pharma",
    "active_substance": "Sertralin",
    "form": "Filmtablette",
    "strength": "100 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000045",
    "trade_name": "Citalopram-ratiopharm",
    "active_substance": "Citalopram",
    "form": "Filmtablette",
    "strength": "20 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000046",
    "trade_name": "Citalopram-ratiopharm",
    "active_substance": "Citalopram",
    "form": "Filmtablette",
    "strength": "40 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000047",
    "trade_name": "Escitalopram HEXAL",
    "active_substance": "Escitalopram",
    "form": "Filmtablette",
    "strength": "10 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000048",
    "trade_name": "Escitalopram HEXAL",
    "active_substance": "Escitalopram",
    "form": "Filmtablette",
    "strength": "20 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000049",
    "trade_name": "Fluoxetin-ratiopharm",
    "active_substance": "Fluoxetin",
    "form": "Kapsel",
    "strength": "20 mg",
    "norm_size": "N3",
    "dosage_unit": "Kapsel"
  },
  {
    "pzn": "10000050",
    "trade_name": "Ibuprofen AL",
    "active_substance": "Ibuprofen",
    "form": "Filmtablette",
    "strength": "400 mg",
    "norm_size": "N2",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000051",
    "trade_name": "Ibuprofen AL",
    "active_substance": "Ibuprofen",
    "form": "Filmtablette",
    "strength": "600 mg",
    "norm_size": "N2",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000052",
    "trade_name": "Ibuprofen AL",
    "active_substance": "Ibuprofen",
    "form": "Filmtablette",
    "strength": "800 mg",
    "norm_size": "N2",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000053",
    "trade_name": "Paracetamol-ratiopharm",
    "active_substance": "Paracetamol",
    "form": "Tablette",
    "strength": "500 mg",
    "norm_size": "N2",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000054",
    "trade_name": "Paracetamol-ratiopharm",
    "active_substance": "Paracetamol",
    "form": "Tablette",
    "strength": "1000 mg",
    "norm_size": "N2",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000055",
    "trade_name": "Novalgin",
    "active_substance": "Metamizol",
    "form": "Tablette",
    "strength": "500 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000056",
    "trade_name": "Diclofenac-ratiopharm",
    "active_substance": "Diclofenac",
    "form": "Magensaftresistente Tablette",
    "strength": "50 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000057",
    "trade_name": "Diclofenac-ratiopharm",
    "active_substance": "Diclofenac",
    "form": "Magensaftresistente Tablette",
    "strength": "75 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000058",
    "trade_name": "Naproxen-ratiopharm",
    "active_substance": "Naproxen",
    "form": "Tablette",
    "strength": "250 mg",
    "norm_size": "N2",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000059",
    "trade_name": "Naproxen-ratiopharm",
    "active_substance": "Naproxen",
    "form": "Tablette",
    "strength": "500 mg",
    "norm_size": "N2",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000060",
    "trade_name": "Tramadol AL",
    "active_substance": "Tramadol",
    "form": "Retardtablette",
    "strength": "50 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000061",
    "trade_name": "Tramadol AL",
    "active_substance": "Tramadol",
    "form": "Retardtablette",
    "strength": "100 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000062",
    "trade_name": "Amoxicillin-ratiopharm",
    "active_substance": "Amoxicillin",
    "form": "Filmtablette",
    "strength": "750 mg",
    "norm_size": "N2",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000063",
    "trade_name": "Amoxicillin-ratiopharm",
    "active_substance": "Amoxicillin",
    "form": "Filmtablette",
    "strength": "1000 mg",
    "norm_size": "N2",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000064",
    "trade_name": "Cefuroxim-ratiopharm",
    "active_substance": "Cefuroxim",
    "form": "Filmtablette",
    "strength": "250 mg",
    "norm_size": "N2",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000065",
    "trade_name": "Cefuroxim-ratiopharm",
    "active_substance": "Cefuroxim",
    "form": "Filmtablette",
    "strength": "500 mg",
    "norm_size": "N2",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000066",
    "trade_name": "Azithromycin HEXAL",
    "active_substance": "Azithromycin",
    "form": "Filmtablette",
    "strength": "250 mg",
    "norm_size": "N1",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000067",
    "trade_name": "Azithromycin HEXAL",
    "active_substance": "Azithromycin",
    "form": "Filmtablette",
    "strength": "500 mg",
    "norm_size": "N1",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000068",
    "trade_name": "Doxycyclin AL",
    "active_substance": "Doxycyclin",
    "form": "Tablette",
    "strength": "100 mg",
    "norm_size": "N2",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000069",
    "trade_name": "Cotrim forte-ratiopharm",
    "active_substance": "Sulfamethoxazol/Trimethoprim",
    "form": "Tablette",
    "strength": "800/160 mg",
    "norm_size": "N2",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000070",
    "trade_name": "Ciprofloxacin-ratiopharm",
    "active_substance": "Ciprofloxacin",
    "form": "Filmtablette",
    "strength": "500 mg",
    "norm_size": "N2",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000071",
    "trade_name": "Ciprofloxacin-ratiopharm",
    "active_substance": "Ciprofloxacin",
    "form": "Filmtablette",
    "strength": "750 mg",
    "norm_size": "N2",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000072",
    "trade_name": "L-Thyroxin Henning",
    "active_substance": "Levothyroxin",
    "form": "Tablette",
    "strength": "50 µg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000073",
    "trade_name": "L-Thyroxin Henning",
    "active_substance": "Levothyroxin",
    "form": "Tablette",
    "strength": "75 µg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000074",
    "trade_name": "L-Thyroxin Henning",
    "active_substance": "Levothyroxin",
    "form": "Tablette",
    "strength": "100 µg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000075",
    "trade_name": "L-Thyroxin Henning",
    "active_substance": "Levothyroxin",
    "form": "Tablette",
    "strength": "125 µg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000076",
    "trade_name": "L-Thyroxin Henning",
    "active_substance": "Levothyroxin",
    "form": "Tablette",
    "strength": "150 µg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000077",
    "trade_name": "Eliquis",
    "active_substance": "Apixaban",
    "form": "Filmtablette",
    "strength": "2.5 mg",
    "norm_size": "N2",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000078",
    "trade_name": "Eliquis",
    "active_substance": "Apixaban",
    "form": "Filmtablette",
    "strength": "5 mg",
    "norm_size": "N2",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000079",
    "trade_name": "Xarelto",
    "active_substance": "Rivaroxaban",
    "form": "Filmtablette",
    "strength": "10 mg",
    "norm_size": "N2",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000080",
    "trade_name": "Xarelto",
    "active_substance": "Rivaroxaban",
    "form": "Filmtablette",
    "strength": "20 mg",
    "norm_size": "N2",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000081",
    "trade_name": "Pradaxa",
    "active_substance": "Dabigatran",
    "form": "Hartkapsel",
    "strength": "110 mg",
    "norm_size": "N2",
    "dosage_unit": "Kapsel"
  },
  {
    "pzn": "10000082",
    "trade_name": "Pradaxa",
    "active_substance": "Dabigatran",
    "form": "Hartkapsel",
    "strength": "150 mg",
    "norm_size": "N2",
    "dosage_unit": "Kapsel"
  },
  {
    "pzn": "10000083",
    "trade_name": "Lixiana",
    "active_substance": "Edoxaban",
    "form": "Filmtablette",
    "strength": "30 mg",
    "norm_size": "N2",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000084",
    "trade_name": "Lixiana",
    "active_substance": "Edoxaban",
    "form": "Filmtablette",
    "strength": "60 mg",
    "norm_size": "N2",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000085",
    "trade_name": "Marcumar",
    "active_substance": "Phenprocoumon",
    "form": "Tablette",
    "strength": "3 mg",
    "norm_size": "N2",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000086",
    "trade_name": "Torasemid-ratiopharm",
    "active_substance": "Torasemid",
    "form": "Tablette",
    "strength": "5 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000087",
    "trade_name": "Torasemid-ratiopharm",
    "active_substance": "Torasemid",
    "form": "Tablette",
    "strength": "10 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000088",
    "trade_name": "Furosemid-ratiopharm",
    "active_substance": "Furosemid",
    "form": "Tablette",
    "strength": "20 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000089",
    "trade_name": "Furosemid-ratiopharm",
    "active_substance": "Furosemid",
    "form": "Tablette",
    "strength": "40 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000090",
    "trade_name": "Mirtazapin HEXAL",
    "active_substance": "Mirtazapin",
    "form": "Filmtablette",
    "strength": "15 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000091",
    "trade_name": "Mirtazapin HEXAL",
    "active_substance": "Mirtazapin",
    "form": "Filmtablette",
    "strength": "30 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000092",
    "trade_name": "ASS-ratiopharm",
    "active_substance": "Acetylsalicylsäure",
    "form": "Tablette",
    "strength": "100 mg",
    "norm_size": "N2",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000093",
    "trade_name": "ASS-ratiopharm",
    "active_substance": "Acetylsalicylsäure",
    "form": "Tablette",
    "strength": "500 mg",
    "norm_size": "N2",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000094",
    "trade_name": "Levothyroxin Aristo",
    "active_substance": "Levothyroxin",
    "form": "Tablette",
    "strength": "50 µg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000095",
    "trade_name": "Levothyroxin Aristo",
    "active_substance": "Levothyroxin",
    "form": "Tablette",
    "strength": "100 µg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000096",
    "trade_name": "Concor COR",
    "active_substance": "Bisoprolol",
    "form": "Filmtablette",
    "strength": "2.5 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000097",
    "trade_name": "Concor COR",
    "active_substance": "Bisoprolol",
    "form": "Filmtablette",
    "strength": "5 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000098",
    "trade_name": "Beloc ZOK",
    "active_substance": "Metoprolol",
    "form": "Retardtablette",
    "strength": "47.5 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  },
  {
    "pzn": "10000099",
    "trade_name": "Beloc ZOK",
    "active_substance": "Metoprolol",
    "form": "Retardtablette",
    "strength": "95 mg",
    "norm_size": "N3",
    "dosage_unit": "Tablette"
  }
];

/**
 * Ranked local PZN search:
 *  1) exact PZN
 *  2) trade_name startsWith
 *  3) active_substance startsWith
 *  4) substring matches (trade_name, active_substance, pzn)
 */
export function searchPZN(query: string, limit = 10): PZNEntry[] {
  const qRaw = query.trim();
  if (!qRaw) return [];

  const qLower = qRaw.toLowerCase();
  const qPzn = qRaw.replace(/\s+/g, '').toLowerCase();

  const exactPzn: PZNEntry[] = [];
  const tradePrefix: PZNEntry[] = [];
  const substancePrefix: PZNEntry[] = [];
  const contains: PZNEntry[] = [];

  for (const entry of PZN_DATA) {
    const trade = entry.trade_name.toLowerCase();
    const substance = entry.active_substance.toLowerCase();

    const pzn = entry.pzn.toLowerCase();

    if (pzn === qPzn) {
      exactPzn.push(entry);
    } else if (trade.startsWith(qLower)) {
      tradePrefix.push(entry);
    } else if (substance.startsWith(qLower)) {
      substancePrefix.push(entry);
    } else if (
      trade.includes(qLower) ||
      substance.includes(qLower) ||
      pzn.includes(qPzn)
    ) {
      contains.push(entry);
    }
  }

  return [...exactPzn, ...tradePrefix, ...substancePrefix, ...contains].slice(0, limit);
}
