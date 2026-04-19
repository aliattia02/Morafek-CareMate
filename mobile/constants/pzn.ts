/**
 * Local PZN lookup data (starter set) for doctor prescription UI.
 *
 * Format mirrors constants/icd10gm.ts:
 *  - p: 8-digit PZN
 *  - t: trade name
 *  - a: active substance
 *  - f: dosage form
 *  - s: strength
 *  - n: norm size (N1|N2|N3)
 */

export type NormSize = 'N1' | 'N2' | 'N3';

export interface PZNEntry {
  p: string;
  t: string;
  a: string;
  f: string;
  s: string;
  n: NormSize;
}

export const PZN_DATA: PZNEntry[] = [
  { p: '01234567', t: 'Ibuprofen AL', a: 'Ibuprofen', f: 'Filmtabletten', s: '400 mg', n: 'N2' },
  { p: '01234568', t: 'Ibuprofen AL', a: 'Ibuprofen', f: 'Filmtabletten', s: '600 mg', n: 'N2' },
  { p: '01234569', t: 'Ibuprofen AL', a: 'Ibuprofen', f: 'Filmtabletten', s: '800 mg', n: 'N1' },
  { p: '09876543', t: 'Paracetamol-ratiopharm', a: 'Paracetamol', f: 'Tabletten', s: '500 mg', n: 'N2' },
  { p: '09876544', t: 'Paracetamol-ratiopharm', a: 'Paracetamol', f: 'Tabletten', s: '1000 mg', n: 'N1' },
  { p: '11223344', t: 'Metformin HEXAL', a: 'Metformin', f: 'Filmtabletten', s: '500 mg', n: 'N3' },
  { p: '11223345', t: 'Metformin HEXAL', a: 'Metformin', f: 'Filmtabletten', s: '850 mg', n: 'N3' },
  { p: '11223346', t: 'Metformin HEXAL', a: 'Metformin', f: 'Filmtabletten', s: '1000 mg', n: 'N3' },
  { p: '22334455', t: 'L-Thyroxin Henning', a: 'Levothyroxin', f: 'Tabletten', s: '50 µg', n: 'N3' },
  { p: '22334456', t: 'L-Thyroxin Henning', a: 'Levothyroxin', f: 'Tabletten', s: '75 µg', n: 'N3' },
  { p: '22334457', t: 'L-Thyroxin Henning', a: 'Levothyroxin', f: 'Tabletten', s: '100 µg', n: 'N3' },
  { p: '33445566', t: 'Ramipril HEXAL', a: 'Ramipril', f: 'Tabletten', s: '2.5 mg', n: 'N3' },
  { p: '33445567', t: 'Ramipril HEXAL', a: 'Ramipril', f: 'Tabletten', s: '5 mg', n: 'N3' },
  { p: '33445568', t: 'Ramipril HEXAL', a: 'Ramipril', f: 'Tabletten', s: '10 mg', n: 'N3' },
  { p: '44556677', t: 'Bisoprolol-ratiopharm', a: 'Bisoprolol', f: 'Filmtabletten', s: '2.5 mg', n: 'N3' },
  { p: '44556678', t: 'Bisoprolol-ratiopharm', a: 'Bisoprolol', f: 'Filmtabletten', s: '5 mg', n: 'N3' },
  { p: '44556679', t: 'Bisoprolol-ratiopharm', a: 'Bisoprolol', f: 'Filmtabletten', s: '10 mg', n: 'N3' },
  { p: '55667788', t: 'Amlodipin STADA', a: 'Amlodipin', f: 'Tabletten', s: '5 mg', n: 'N3' },
  { p: '55667789', t: 'Amlodipin STADA', a: 'Amlodipin', f: 'Tabletten', s: '10 mg', n: 'N3' },
  { p: '66778899', t: 'Atorvastatin-ratiopharm', a: 'Atorvastatin', f: 'Filmtabletten', s: '10 mg', n: 'N3' },
  { p: '66778900', t: 'Atorvastatin-ratiopharm', a: 'Atorvastatin', f: 'Filmtabletten', s: '20 mg', n: 'N3' },
  { p: '66778901', t: 'Atorvastatin-ratiopharm', a: 'Atorvastatin', f: 'Filmtabletten', s: '40 mg', n: 'N3' },
  { p: '77889900', t: 'Pantoprazol AL', a: 'Pantoprazol', f: 'magensaftresistente Tabletten', s: '20 mg', n: 'N3' },
  { p: '77889901', t: 'Pantoprazol AL', a: 'Pantoprazol', f: 'magensaftresistente Tabletten', s: '40 mg', n: 'N3' },
  { p: '88990011', t: 'ASS-ratiopharm', a: 'Acetylsalicylsäure', f: 'Tabletten', s: '100 mg', n: 'N3' },
  { p: '88990012', t: 'ASS-ratiopharm', a: 'Acetylsalicylsäure', f: 'Tabletten', s: '500 mg', n: 'N2' },
  { p: '99001122', t: 'Amoxicillin-ratiopharm', a: 'Amoxicillin', f: 'Filmtabletten', s: '1000 mg', n: 'N2' },
  { p: '99001123', t: 'Amoxicillin-ratiopharm', a: 'Amoxicillin', f: 'Saft', s: '250 mg/5 ml', n: 'N1' },
  { p: '10111213', t: 'Xarelto', a: 'Rivaroxaban', f: 'Filmtabletten', s: '10 mg', n: 'N2' },
  { p: '10111214', t: 'Xarelto', a: 'Rivaroxaban', f: 'Filmtabletten', s: '20 mg', n: 'N2' },
  { p: '12131415', t: 'Eliquis', a: 'Apixaban', f: 'Filmtabletten', s: '2.5 mg', n: 'N2' },
  { p: '12131416', t: 'Eliquis', a: 'Apixaban', f: 'Filmtabletten', s: '5 mg', n: 'N2' },
  { p: '14151617', t: 'Novorapid FlexPen', a: 'Insulin aspart', f: 'Injektionslösung', s: '100 IE/ml', n: 'N2' },
  { p: '14151618', t: 'Lantus SoloStar', a: 'Insulin glargin', f: 'Injektionslösung', s: '100 IE/ml', n: 'N2' },
];
