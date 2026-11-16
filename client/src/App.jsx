import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import Layout from './pages/Layout';
import Login from './pages/Login';
const PerformancePage = lazy(() => import('./pages/PerformancePage'));
const BackupPage = lazy(() => import('./pages/BackupPage'));
const Home = lazy(() => import('./pages/Home'));
const ProgramPage = lazy(() => import('./pages/ProgramPage'));
const NewEnrollment = lazy(() => import('./pages/NewEnrollment'));
const EnrollmentProfile = lazy(() => import('./pages/EnrollmentProfile'));
const TrackerPage = lazy(() => import('./pages/TrackerPage'));
const VerifyPage = lazy(() => import('./pages/VerifyPage'));
const Settings = lazy(() => import('./pages/Settings'));
const ImportPage = lazy(() => import('./pages/ImportPage'));
const ActivityPage = lazy(() => import('./pages/ActivityPage'));
import { Loading } from './components/ui';

export default function App() {
  const { user, ready } = useAuth();
  if (!ready) return <Loading />;
  if (!user) {
    return (
      <Routes>
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }
  return (
    <Suspense fallback={<Loading />}>
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="p/:programId/:batchId/enroll" element={<NewEnrollment />} />
        <Route path="p/:programId/:batchId?/:tab?" element={<ProgramPage />} />
        <Route path="enrollments/:id" element={<EnrollmentProfile />} />
        <Route path="tracker" element={<TrackerPage />} />
        <Route path="verify" element={<VerifyPage />} />
        <Route path="settings" element={<Settings />} />
        <Route path="import" element={<ImportPage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="performance" element={<PerformancePage />} />
        <Route path="backup" element={<BackupPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
    </Suspense>
  );
}