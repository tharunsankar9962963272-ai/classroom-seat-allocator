/**
 * Compute the seat layout for a classroom.
 * Imported by BOTH server.js (authoritative) and public/app.js (live preview).
 *
 * @param {number} students      Number of students (integer >= 0).
 * @param {number} seatsPerRow   Seats in each row (integer >= 1).
 * @returns {{ rowsRequired: number, totalSeats: number, emptySeatsInLastRow: number }}
 */
export function computeLayout(students, seatsPerRow) {
  const rowsRequired = Math.ceil(students / seatsPerRow);
  const totalSeats = rowsRequired * seatsPerRow;
  const emptySeatsInLastRow = totalSeats - students;
  return { rowsRequired, totalSeats, emptySeatsInLastRow };
}