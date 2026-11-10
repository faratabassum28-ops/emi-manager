import TrackerTable from '../components/TrackerTable';

export default function TrackerPage() {
  return (
    <>
      <div className="page-head"><div><h1>EMI Tracker</h1><div className="muted">Every row is one action. Rows with a promised date return to the queue after that date.</div></div></div>
      <TrackerTable showBatch />
    </>
  );
}
