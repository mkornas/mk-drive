import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./pages/home').then((m) => m.HomePage), title: 'mk-drive' },
  { path: 'login', loadComponent: () => import('./pages/login').then((m) => m.LoginPage), title: 'Sign in · mk-drive' },
  { path: 's/:id', loadComponent: () => import('./pages/share').then((m) => m.SharePage), title: 'Shared · mk-drive' },
  { path: 'setup', loadComponent: () => import('./pages/setup').then((m) => m.SetupPage), title: 'Set up · mk-drive' },
  { path: 'd', children: [{ path: '**', loadComponent: () => import('./pages/browse').then((m) => m.BrowsePage) }] },
  { path: 'recent', loadComponent: () => import('./pages/marked').then((m) => m.MarkedPage), data: { kind: 'recent' }, title: 'Recent · mk-drive' },
  { path: 'starred', loadComponent: () => import('./pages/marked').then((m) => m.MarkedPage), data: { kind: 'starred' }, title: 'Starred · mk-drive' },
  { path: 'shared', loadComponent: () => import('./pages/shared').then((m) => m.SharedPage), title: 'Shared with me · mk-drive' },
  { path: 'photos', loadComponent: () => import('./pages/photos').then((m) => m.PhotosPage), title: 'Photos · mk-drive' },
  { path: 'share', loadComponent: () => import('./pages/receive').then((m) => m.ReceivePage), title: 'Save to the drive · mk-drive' },
  { path: 'trash/:location', loadComponent: () => import('./pages/trash').then((m) => m.TrashPage), title: 'Trash · mk-drive' },
  {
    path: 'settings',
    children: [
      { path: '', redirectTo: 'account', pathMatch: 'full' },
      { path: 'account', loadComponent: () => import('./pages/settings/account').then((m) => m.AccountPage), title: 'Account · mk-drive' },
      { path: 'devices', loadComponent: () => import('./pages/settings/devices').then((m) => m.DevicesPage), title: 'Devices · mk-drive' },
      {
        path: 'notifications',
        loadComponent: () => import('./pages/settings/notifications').then((m) => m.NotificationsPage),
        title: 'Notifications · mk-drive',
      },
      { path: 'connect', loadComponent: () => import('./pages/settings/connect').then((m) => m.ConnectPage), title: 'Connect · mk-drive' },
      { path: 'links', loadComponent: () => import('./pages/settings/shares').then((m) => m.SharesPage), title: 'Links · mk-drive' },
      { path: 'people', loadComponent: () => import('./pages/settings/people').then((m) => m.PeoplePage), title: 'People · mk-drive' },
      { path: 'locations', loadComponent: () => import('./pages/settings/locations').then((m) => m.LocationsPage), title: 'Locations · mk-drive' },
      { path: 'sign-in', loadComponent: () => import('./pages/settings/sign-in').then((m) => m.SignInSettingsPage), title: 'Sign-in · mk-drive' },
      { path: 'activity', loadComponent: () => import('./pages/settings/activity').then((m) => m.ActivityPage), title: 'Activity · mk-drive' },
    ],
  },
  {
    path: 'storage',
    children: [
      { path: '', redirectTo: 'overview', pathMatch: 'full' },
      { path: 'health', redirectTo: 'overview', pathMatch: 'full' },
      { path: 'overview', loadComponent: () => import('./pages/storage/overview').then((m) => m.StorageOverviewPage), title: 'Storage · mk-drive' },
      { path: 'setup', loadComponent: () => import('./pages/storage/setup').then((m) => m.StorageSetupPage), title: 'Set up · Storage · mk-drive' },
      { path: 'disks', loadComponent: () => import('./pages/storage/disks').then((m) => m.StorageDisksPage), title: 'Disks · Storage · mk-drive' },
      { path: 'pools', loadComponent: () => import('./pages/storage/pools').then((m) => m.StoragePoolsPage), title: 'Pools · Storage · mk-drive' },
      { path: 'datasets', loadComponent: () => import('./pages/storage/datasets').then((m) => m.StorageDatasetsPage), title: 'Datasets · Storage · mk-drive' },
      {
        path: 'snapshots',
        loadComponent: () => import('./pages/storage/snapshots').then((m) => m.StorageSnapshotsPage),
        title: 'Snapshots · Storage · mk-drive',
      },
      {
        path: 'shares',
        loadComponent: () => import('./pages/storage/shares').then((m) => m.StorageSharesPage),
        title: 'Shares · Storage · mk-drive',
      },
      {
        path: 'replication',
        loadComponent: () => import('./pages/storage/replication').then((m) => m.StorageReplicationPage),
        title: 'Copies · Storage · mk-drive',
      },
      {
        path: 'network',
        loadComponent: () => import('./pages/storage/network').then((m) => m.StorageNetworkPage),
        title: 'Network · Storage · mk-drive',
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
