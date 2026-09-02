const API_BASE_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ? window.location.origin
  : 'https://hidely-backend.onrender.com';

let token = localStorage.getItem('hidely_admin_token') || '';
let currentAdmin = JSON.parse(localStorage.getItem('hidely_admin_user') || 'null');

document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

function initApp() {
  if (token && currentAdmin) {
    showDashboard();
  } else {
    showLogin();
  }

  setupEventListeners();
}

function setupEventListeners() {
  // Login form
  const loginForm = document.getElementById('login-form');
  loginForm?.addEventListener('submit', handleLogin);

  // Logout button
  document.getElementById('logout-btn')?.addEventListener('click', handleLogout);

  // Mobile sidebar drawer toggle
  const mobileToggle = document.getElementById('mobile-sidebar-toggle');
  const sidebarOverlay = document.getElementById('sidebar-overlay');
  const sidebar = document.querySelector('.sidebar');

  mobileToggle?.addEventListener('click', () => {
    sidebar?.classList.toggle('open');
    sidebarOverlay?.classList.toggle('open');
  });

  sidebarOverlay?.addEventListener('click', () => {
    sidebar?.classList.remove('open');
    sidebarOverlay?.classList.remove('open');
  });

  // Tab switching & close mobile drawer on select
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const targetTab = e.currentTarget.getAttribute('data-tab');
      switchTab(targetTab);
      if (window.innerWidth <= 960) {
        sidebar?.classList.remove('open');
        sidebarOverlay?.classList.remove('open');
      }
    });
  });

  // Places search & modal
  document.getElementById('places-search')?.addEventListener('input', debounce(loadPlaces, 300));
  document.getElementById('open-add-place-modal')?.addEventListener('click', openAddPlaceModal);
  document.getElementById('close-place-modal')?.addEventListener('click', closePlaceModal);
  document.getElementById('cancel-place-modal')?.addEventListener('click', closePlaceModal);
  document.getElementById('place-form')?.addEventListener('submit', handleSavePlace);

  // Users search
  document.getElementById('users-search')?.addEventListener('input', debounce(loadUsers, 300));

  // Posts search
  document.getElementById('posts-search')?.addEventListener('input', debounce(loadPosts, 300));

  // Broadcast form
  document.getElementById('broadcast-form')?.addEventListener('submit', handleBroadcast);
}

// Authentication Handlers
async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;
  const errBox = document.getElementById('login-error');
  const submitBtn = document.querySelector('#login-form button[type="submit"]');

  errBox.classList.add('hidden');
  const originalBtnHtml = submitBtn.innerHTML;
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Connecting to Console...';

  try {
    let res = await fetch(`${API_BASE_URL}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    if (res.status === 404) {
      // Fallback to primary auth login endpoint
      res = await fetch(`${API_BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
    }

    const data = await res.json();
    submitBtn.disabled = false;
    submitBtn.innerHTML = originalBtnHtml;

    if (!res.ok) {
      errBox.textContent = data.error || 'Login failed. Please check your credentials.';
      errBox.classList.remove('hidden');
      return;
    }

    const adminObj = data.admin || data.user || { name: 'Admin User', email: email };
    token = data.token;
    currentAdmin = adminObj;
    localStorage.setItem('hidely_admin_token', token);
    localStorage.setItem('hidely_admin_user', JSON.stringify(currentAdmin));

    showDashboard();
  } catch (err) {
    submitBtn.disabled = false;
    submitBtn.innerHTML = originalBtnHtml;
    console.error('Login error:', err);
    errBox.textContent = 'Backend server connection error. Please try again.';
    errBox.classList.remove('hidden');
  }
}

function handleLogout() {
  token = '';
  currentAdmin = null;
  localStorage.removeItem('hidely_admin_token');
  localStorage.removeItem('hidely_admin_user');
  showLogin();
}

function showLogin() {
  document.getElementById('login-container').classList.remove('hidden');
  document.getElementById('app-container').classList.add('hidden');
}

function showDashboard() {
  document.getElementById('login-container').classList.add('hidden');
  document.getElementById('app-container').classList.remove('hidden');

  if (currentAdmin) {
    document.getElementById('admin-name').textContent = currentAdmin.name || currentAdmin.username;
  }

  loadStats();
}

// Navigation Tab Switching
function switchTab(tabId) {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
  });

  document.querySelectorAll('.tab-page').forEach(page => {
    page.classList.toggle('active', page.id === `tab-${tabId}`);
  });

  const titles = {
    dashboard: 'Overview Dashboard',
    places: 'Hidden Places & Spots',
    users: 'Users & Creators',
    posts: 'Community Moderation',
    broadcast: 'System Broadcasts',
  };

  const subs = {
    dashboard: 'Real-time stats and platform health',
    places: 'Manage curated hidden places and coordinates',
    users: 'Manage users, verification badges and roles',
    posts: 'Review and moderate community posts',
    broadcast: 'Send system-wide broadcast notifications',
  };

  document.getElementById('current-tab-title').textContent = titles[tabId] || 'Admin Console';
  document.getElementById('current-tab-sub').textContent = subs[tabId] || '';

  if (tabId === 'dashboard') loadStats();
  if (tabId === 'places') loadPlaces();
  if (tabId === 'users') loadUsers();
  if (tabId === 'posts') loadPosts();
}

// Helper: Authorized API Fetch
async function apiFetch(endpoint, options = {}) {
  options.headers = {
    ...(options.headers || {}),
    'Authorization': `Bearer ${token}`,
  };

  const res = await fetch(`${API_BASE_URL}${endpoint}`, options);
  if (res.status === 401 || res.status === 403) {
    handleLogout();
    throw new Error('Unauthorized');
  }
  return res.json();
}

// Load Overview Dashboard Stats
async function loadStats() {
  try {
    const data = await apiFetch('/api/admin/stats');
    if (!data.stats) return;

    document.getElementById('stat-users').textContent = data.stats.totalUsers;
    document.getElementById('stat-places').textContent = data.stats.totalPlaces;
    document.getElementById('stat-posts').textContent = data.stats.totalPosts;
    document.getElementById('stat-likes').textContent = data.stats.totalLikes;

    const tbody = document.getElementById('recent-activity-body');
    if (!data.recentPosts || data.recentPosts.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-center">No recent activity.</td></tr>';
      return;
    }

    tbody.innerHTML = data.recentPosts.map(p => `
      <tr>
        <td><strong>${escapeHtml(p.author_name || p.author_username)}</strong></td>
        <td>${escapeHtml(p.caption || 'No caption')}</td>
        <td><img src="${getMediaUrl(p.image_url)}" class="img-thumb" alt="" onerror="this.onerror=null; this.src='/assets/images/app_icon.png';"></td>
        <td>${new Date(p.created_at).toLocaleDateString()}</td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

// Load Places List
async function loadPlaces() {
  const query = document.getElementById('places-search')?.value || '';
  try {
    const data = await apiFetch(`/api/admin/places?query=${encodeURIComponent(query)}`);
    const tbody = document.getElementById('places-list-body');

    if (!data.places || data.places.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center">No hidden places found.</td></tr>';
      return;
    }

    tbody.innerHTML = data.places.map(p => `
      <tr>
        <td>#${p.id}</td>
        <td><strong>${escapeHtml(p.name)}</strong></td>
        <td><span class="badge badge-purple">${escapeHtml(p.category || 'Attraction')}</span></td>
        <td>${p.latitude.toFixed(4)}, ${p.longitude.toFixed(4)}</td>
        <td>⭐ ${p.rating || 4.8}</td>
        <td>${p.is_featured ? '<span class="badge badge-emerald">Featured</span>' : 'Standard'}</td>
        <td>
          <button class="btn btn-sm btn-danger" onclick="deletePlace(${p.id})"><i class="fa-solid fa-trash"></i> Delete</button>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('Failed to load places:', err);
  }
}

// Save New Place
async function handleSavePlace(e) {
  e.preventDefault();
  const name = document.getElementById('place-name').value;
  const category = document.getElementById('place-category').value;
  const rating = document.getElementById('place-rating').value;
  const latitude = document.getElementById('place-lat').value;
  const longitude = document.getElementById('place-lng').value;
  const description = document.getElementById('place-description').value;
  const image_url = document.getElementById('place-image-url').value;
  const is_featured = document.getElementById('place-featured').checked;

  try {
    const res = await apiFetch('/api/admin/places', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name, category, rating, latitude, longitude, description, image_url, is_featured
      }),
    });

    closePlaceModal();
    loadPlaces();
  } catch (err) {
    alert('Failed to save place: ' + err.message);
  }
}

async function deletePlace(id) {
  if (!confirm('Are you sure you want to delete this place?')) return;
  try {
    await apiFetch(`/api/admin/places/${id}`, { method: 'DELETE' });
    loadPlaces();
  } catch (err) {
    alert('Failed to delete place');
  }
}

// Load Users List
async function loadUsers() {
  const query = document.getElementById('users-search')?.value || '';
  try {
    const data = await apiFetch(`/api/admin/users?query=${encodeURIComponent(query)}`);
    const tbody = document.getElementById('users-list-body');

    if (!data.users || data.users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center">No users found.</td></tr>';
      return;
    }

    tbody.innerHTML = data.users.map(u => `
      <tr>
        <td>
          <strong>${escapeHtml(u.name)}</strong><br>
          <small>@${escapeHtml(u.username || 'user')}</small>
        </td>
        <td>${escapeHtml(u.email)}</td>
        <td>${u.points || 0} pts</td>
        <td>
          <button class="btn btn-sm ${u.is_verified ? 'btn-success' : 'btn-secondary'}" onclick="toggleVerify(${u.id}, ${!u.is_verified})">
            ${u.is_verified ? '✓ Verified' : 'Verify'}
          </button>
        </td>
        <td>
          <button class="btn btn-sm ${u.is_admin ? 'btn-primary' : 'btn-secondary'}" onclick="toggleAdmin(${u.id}, ${!u.is_admin})">
            ${u.is_admin ? '👑 Admin' : 'Make Admin'}
          </button>
        </td>
        <td>
          <button class="btn btn-sm btn-danger" onclick="deleteUser(${u.id})"><i class="fa-solid fa-user-xmark"></i> Ban</button>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('Failed to load users:', err);
  }
}

async function toggleVerify(userId, isVerified) {
  try {
    await apiFetch(`/api/admin/users/${userId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_verified: isVerified }),
    });
    loadUsers();
  } catch (err) {
    alert('Failed to update verification status');
  }
}

async function toggleAdmin(userId, isAdmin) {
  try {
    await apiFetch(`/api/admin/users/${userId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_admin: isAdmin }),
    });
    loadUsers();
  } catch (err) {
    alert('Failed to update admin role');
  }
}

async function deleteUser(userId) {
  if (!confirm('Are you sure you want to ban/delete this user?')) return;
  try {
    await apiFetch(`/api/admin/users/${userId}`, { method: 'DELETE' });
    loadUsers();
  } catch (err) {
    alert('Failed to delete user');
  }
}

// Load Community Posts
async function loadPosts() {
  const query = document.getElementById('posts-search')?.value || '';
  try {
    const data = await apiFetch(`/api/admin/posts?query=${encodeURIComponent(query)}`);
    const tbody = document.getElementById('posts-list-body');

    if (!data.posts || data.posts.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center">No community posts found.</td></tr>';
      return;
    }

    tbody.innerHTML = data.posts.map(p => `
      <tr>
        <td>#${p.id}</td>
        <td><strong>${escapeHtml(p.author_name || p.author_username)}</strong></td>
        <td>${escapeHtml(p.caption || 'No caption')}</td>
        <td>${escapeHtml(p.location || 'Unknown')}</td>
        <td><img src="${getMediaUrl(p.image_url)}" class="img-thumb" alt="" onerror="this.onerror=null; this.src='/assets/images/app_icon.png';"></td>
        <td>❤️ ${p.likes_count || 0}</td>
        <td>
          <button class="btn btn-sm btn-danger" onclick="deletePost(${p.id})"><i class="fa-solid fa-trash"></i> Remove</button>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('Failed to load posts:', err);
  }
}

async function deletePost(postId) {
  if (!confirm('Are you sure you want to delete this post?')) return;
  try {
    await apiFetch(`/api/admin/posts/${postId}`, { method: 'DELETE' });
    loadPosts();
  } catch (err) {
    alert('Failed to delete post');
  }
}

// Broadcast Notification
async function handleBroadcast(e) {
  e.preventDefault();
  const text = document.getElementById('broadcast-text').value;
  const type = document.getElementById('broadcast-type').value;
  const statusBox = document.getElementById('broadcast-status');

  try {
    const data = await apiFetch('/api/admin/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, type }),
    });

    statusBox.textContent = data.message || 'Broadcast sent successfully!';
    statusBox.classList.remove('hidden');
    document.getElementById('broadcast-text').value = '';
  } catch (err) {
    alert('Failed to send broadcast: ' + err.message);
  }
}

// UI Modals
function openAddPlaceModal() {
  document.getElementById('place-form').reset();
  document.getElementById('place-id').value = '';
  document.getElementById('modal-place-title').textContent = 'Add New Hidden Spot';
  document.getElementById('place-modal').classList.remove('hidden');
}

function closePlaceModal() {
  document.getElementById('place-modal').classList.add('hidden');
}

// Utilities
function getMediaUrl(url) {
  if (!url) return '/assets/images/app_icon.png';
  if (url.startsWith('http')) return url;
  if (url.startsWith('/')) return url;
  if (url.startsWith('assets/')) return `/${url}`;
  return `${API_BASE_URL}/${url}`;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}
