/**
 * Everything behind the clinic passcode, bundled as one chunk.
 *
 * Patients open their tracking link on a phone, often on mobile data, and none
 * of them need the desk's code or the QR library. One chunk rather than one per
 * page, so moving between the desk, the report and follow-ups never has to
 * fetch anything mid-shift.
 */
export { default as RequireStaff } from '../components/RequireStaff'
export { default as StaffDashboard } from './StaffDashboard'
export { default as ReportPage } from './ReportPage'
export { default as FollowUpsPage } from './FollowUpsPage'
