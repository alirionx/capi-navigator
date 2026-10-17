// English UI texts (NF-09). The MVP ships English only.
export const en = {
  app: {
    title: 'CAPI Navigator',
    toggleTheme: 'Toggle light/dark theme',
  },
  nav: {
    home: 'Home',
  },
  home: {
    title: 'Welcome to CAPI Navigator',
    subtitle: 'A lean web UI for Cluster API.',
    backend: 'Backend',
    homeCluster: 'Home cluster',
    ok: 'OK',
    unreachable: 'Not reachable',
    checking: 'Checking…',
    error: 'Error',
    refresh: 'Refresh',
    version: 'Version {version}',
  },
};

export type MessageSchema = typeof en;
