// ADMEC Weather - forecast app

const API_KEY = '7c57a5292276867ee277f1081a85c65c';
const CACHE_MINUTES = 30;
const COUNTRY_CACHE = 'countriesCache_v2';

// Used when the country list can't be loaded
const FALLBACK_COUNTRIES = [
  { name: 'Australia', code: 'AU' },
  { name: 'Brazil', code: 'BR' },
  { name: 'Canada', code: 'CA' },
  { name: 'China', code: 'CN' },
  { name: 'France', code: 'FR' },
  { name: 'Germany', code: 'DE' },
  { name: 'India', code: 'IN' },
  { name: 'Japan', code: 'JP' },
  { name: 'United Kingdom', code: 'GB' },
  { name: 'United States', code: 'US' }
];

const FALLBACK_CITIES = {
  AU: ['Adelaide', 'Brisbane', 'Canberra', 'Gold Coast', 'Melbourne', 'Newcastle', 'Perth', 'Sydney'],
  BR: ['Belo Horizonte', 'Brasília', 'Curitiba', 'Fortaleza', 'Manaus', 'Rio de Janeiro', 'Salvador', 'São Paulo'],
  CA: ['Calgary', 'Edmonton', 'Montreal', 'Ottawa', 'Quebec City', 'Toronto', 'Vancouver', 'Winnipeg'],
  CN: ['Beijing', 'Chongqing', 'Guangzhou', 'Shanghai', 'Shenzhen', 'Tianjin', 'Wuhan'],
  FR: ['Lyon', 'Marseille', 'Montpellier', 'Nantes', 'Nice', 'Paris', 'Strasbourg', 'Toulouse'],
  DE: ['Berlin', 'Cologne', 'Dortmund', 'Düsseldorf', 'Frankfurt', 'Hamburg', 'Munich', 'Stuttgart'],
  IN: ['Ahmedabad', 'Bangalore', 'Chennai', 'Delhi', 'Hyderabad', 'Kolkata', 'Mumbai', 'Pune'],
  JP: ['Fukuoka', 'Kobe', 'Kyoto', 'Nagoya', 'Osaka', 'Sapporo', 'Tokyo', 'Yokohama'],
  GB: ['Birmingham', 'Bristol', 'Glasgow', 'Leeds', 'Liverpool', 'London', 'Manchester', 'Sheffield'],
  US: ['Chicago', 'Houston', 'Los Angeles', 'New York', 'Philadelphia', 'Phoenix', 'San Antonio', 'San Diego']
};

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

// ---------- small helpers ----------

async function fetchWithTimeout(url, options = {}, timeout = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      // storage full or blocked, the app still works without it
    }
  }
};

function esc(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

const $ = (id) => document.getElementById(id);

// ---------- app ----------

class WeatherApp {
  constructor() {
    this.countries = [];
    this.recent = store.get('recentPlaces', []);
    this.unit = store.get('unit', 'metric');
    this.theme = this.initialTheme();

    this.model = null;
    this.dayIndex = 0;
    this.slotIndex = 0;
    this.busy = false;
    this.messageTimer = null;

    this.init();
  }

  initialTheme() {
    let saved = null;
    try {
      saved = localStorage.getItem('theme');
    } catch (e) {}
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  async init() {
    this.bindEvents();
    this.applyTheme();
    this.applyUnit();
    this.renderRecent();
    $('currentYear').textContent = new Date().getFullYear();
    this.clearOldCache();

    await this.loadCountries();

    // open the last place that was looked up
    if (this.recent.length) this.openRecent(0);
  }

  bindEvents() {
    $('searchForm').addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleSearch();
    });

    $('country').addEventListener('change', () => this.loadCities());
    $('locationBtn').addEventListener('click', () => this.useMyLocation());
    $('themeToggle').addEventListener('click', () => this.toggleTheme());

    document.querySelectorAll('[data-unit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.unit = btn.dataset.unit;
        store.set('unit', this.unit);
        this.applyUnit();
        if (this.model) this.renderAll();
      });
    });

    $('recentList').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-recent]');
      if (btn) this.openRecent(Number(btn.dataset.recent));
    });

    // day and time buttons are re-created on every render, so listen on the container
    $('weatherContent').addEventListener('click', (e) => {
      const day = e.target.closest('[data-day]');
      const slot = e.target.closest('[data-slot]');
      if (day) this.selectDay(Number(day.dataset.day));
      else if (slot) this.selectSlot(Number(slot.dataset.slot));
    });
  }

  // ---------- theme and units ----------

  toggleTheme() {
    this.theme = this.theme === 'light' ? 'dark' : 'light';
    try {
      localStorage.setItem('theme', this.theme);
    } catch (e) {}
    this.applyTheme();
  }

  applyTheme() {
    document.documentElement.setAttribute('data-theme', this.theme);
    const btn = $('themeToggle');
    const dark = this.theme === 'dark';
    btn.innerHTML = `<i class="fa-solid ${dark ? 'fa-sun' : 'fa-moon'}" aria-hidden="true"></i>`;
    btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  }

  applyUnit() {
    document.querySelectorAll('[data-unit]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.unit === this.unit));
    });
  }

  // numbers shown to the user, converted from the metric values the API returns
  temp(c) {
    return Math.round(this.unit === 'metric' ? c : c * 9 / 5 + 32);
  }

  speed(ms) {
    return this.unit === 'metric'
      ? `${Math.round(ms * 3.6)} km/h`
      : `${Math.round(ms * 2.237)} mph`;
  }

  distance(m) {
    return this.unit === 'metric'
      ? `${Math.round(m / 1000)} km`
      : `${(m / 1609.34).toFixed(1).replace(/\.0$/, '')} mi`;
  }

  // ---------- countries and cities ----------

  async loadCountries() {
    const select = $('country');
    const cached = store.get(COUNTRY_CACHE);

    if (cached && cached.length) {
      this.countries = cached;
    } else {
      try {
        const res = await fetchWithTimeout('https://restcountries.com/v3.1/all?fields=name,cca2');
        if (!res.ok) throw new Error('countries request failed');
        const data = await res.json();
        this.countries = data
          .map((c) => ({ name: c.name.common, code: c.cca2 }))
          .filter((c) => c.name && c.code);
        if (!this.countries.length) throw new Error('empty country list');
        store.set(COUNTRY_CACHE, this.countries);
      } catch (err) {
        this.countries = FALLBACK_COUNTRIES;
        this.showMessage('The full country list could not be loaded, so a short list is shown instead.');
      }
    }

    select.innerHTML = '<option value="">Select a country</option>';
    this.countries
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((c) => {
        const option = document.createElement('option');
        option.value = c.code;
        option.textContent = c.name;
        select.appendChild(option);
      });
  }

  async loadCities(keepCity = false) {
    const select = $('country');
    const input = $('city');
    const list = $('cityList');
    const code = select.value;
    const name = select.options[select.selectedIndex].textContent;

    list.innerHTML = '';
    if (!keepCity) input.value = '';

    if (!code) {
      input.disabled = true;
      input.placeholder = 'Choose a country first';
      return;
    }

    input.disabled = false;
    input.placeholder = 'Start typing a city';

    const cacheKey = `cities_${code}`;
    let cities = store.get(cacheKey);

    if (!cities) {
      try {
        const res = await fetchWithTimeout(
          'https://countriesnow.space/api/v0.1/countries/cities',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ country: name })
          },
          15000
        );
        const body = await res.json();
        if (!res.ok || body.error || !Array.isArray(body.data)) throw new Error('bad cities response');
        cities = body.data;
        store.set(cacheKey, cities);
      } catch (err) {
        cities = FALLBACK_CITIES[code] || [];
        if (!cities.length) {
          this.showMessage(`The city list for ${name} could not be loaded. You can still type a city name.`);
        }
      }
    }

    // the user may have picked another country while this was loading
    if (select.value !== code) return;

    const fragment = document.createDocumentFragment();
    [...new Set(cities)]
      .sort((a, b) => a.localeCompare(b))
      .forEach((city) => {
        const option = document.createElement('option');
        option.value = city;
        fragment.appendChild(option);
      });
    list.appendChild(fragment);
  }

  // ---------- searching ----------

  handleSearch() {
    const select = $('country');
    const code = select.value;
    const city = $('city').value.trim();

    if (!code) {
      this.showMessage('Select a country first.');
      select.focus();
      return;
    }
    if (!city) {
      this.showMessage('Enter a city name.');
      $('city').focus();
      return;
    }

    this.loadPlace({
      kind: 'q',
      city,
      code,
      country: select.options[select.selectedIndex].textContent
    });
  }

  useMyLocation() {
    if (!navigator.geolocation) {
      this.showMessage('This browser does not support location. Pick a city instead.');
      return;
    }

    const btn = $('locationBtn');
    btn.disabled = true;

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        btn.disabled = false;
        this.loadPlace({
          kind: 'coords',
          lat: Number(pos.coords.latitude.toFixed(2)),
          lon: Number(pos.coords.longitude.toFixed(2))
        });
      },
      (err) => {
        btn.disabled = false;
        const messages = {
          1: 'Location access is blocked. Allow it in the browser settings, or pick a city instead.',
          2: 'Your location is not available right now. Pick a city instead.',
          3: 'Finding your location took too long. Try again.'
        };
        this.showMessage(messages[err.code] || 'Could not get your location.');
      },
      { timeout: 10000 }
    );
  }

  openRecent(index) {
    const place = this.recent[index];
    if (!place) return;

    if (place.kind === 'q') {
      const select = $('country');
      select.value = place.code;
      if (select.value === place.code) {
        $('city').disabled = false;
        $('city').value = place.city;
        this.loadCities(true);
      }
    }
    this.loadPlace(place);
  }

  async loadPlace(place) {
    if (this.busy) return;
    this.busy = true;
    this.setBusy(true);
    this.showView('loading');

    try {
      const query = place.kind === 'coords'
        ? `lat=${place.lat}&lon=${place.lon}`
        : `q=${encodeURIComponent(place.city)},${place.code}`;

      const data = await this.fetchForecast(query);
      const model = this.buildModel(data);

      model.label = place.kind === 'coords'
        ? `${data.city.name}, ${data.city.country}`
        : `${data.city.name}, ${place.country}`;

      this.model = model;
      this.dayIndex = 0;
      this.slotIndex = 0;
      this.remember(place, model.label);
      this.mount();
    } catch (err) {
      this.showMessage(err.message);
      this.showView(this.model ? 'content' : 'empty');
    } finally {
      this.busy = false;
      this.setBusy(false);
    }
  }

  setBusy(isBusy) {
    $('searchBtn').disabled = isBusy;
    $('searchBtn').textContent = isBusy ? 'Loading...' : 'Show forecast';
    $('weatherSection').setAttribute('aria-busy', String(isBusy));
  }

  async fetchForecast(query) {
    const cacheKey = `wx:${query}`;
    const cached = store.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_MINUTES * 60000) return cached.data;

    let res;
    try {
      res = await fetchWithTimeout(
        `https://api.openweathermap.org/data/2.5/forecast?${query}&appid=${API_KEY}&units=metric`
      );
    } catch (err) {
      throw new Error('Could not reach the weather service. Check your connection and try again.');
    }

    if (!res.ok) {
      if (res.status === 404) throw new Error('That city was not found. Check the spelling or pick one from the suggestions.');
      if (res.status === 401) throw new Error('The weather service rejected the API key. Check the key at the top of script.js.');
      if (res.status === 429) throw new Error('Too many requests. Wait a minute and try again.');
      throw new Error('The weather service is not responding. Try again in a moment.');
    }

    const data = await res.json();
    store.set(cacheKey, { data, at: Date.now() });
    return data;
  }

  // remove forecasts that are past their cache time
  clearOldCache() {
    try {
      Object.keys(localStorage)
        .filter((key) => key.startsWith('wx:'))
        .forEach((key) => {
          const item = store.get(key);
          if (!item || Date.now() - item.at > CACHE_MINUTES * 60000) localStorage.removeItem(key);
        });
    } catch (e) {}
  }

  // ---------- turning API data into days ----------

  buildModel(data) {
    const tz = data.city.timezone; // seconds from UTC
    const byDay = new Map();

    data.list.forEach((item) => {
      // shifting by the city's offset lets us read local time with the UTC getters
      const local = new Date((item.dt + tz) * 1000);
      const key = local.toISOString().slice(0, 10);

      const slot = {
        dt: item.dt,
        hour: local.getUTCHours(),
        temp: item.main.temp,
        feels: item.main.feels_like,
        humidity: item.main.humidity,
        pressure: item.main.pressure,
        wind: item.wind.speed,
        deg: item.wind.deg,
        visibility: item.visibility,
        pop: item.pop || 0,
        icon: item.weather[0].icon,
        desc: item.weather[0].description
      };

      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(slot);
    });

    const days = [...byDay.values()]
      // the last day is often cut off after one or two readings
      .filter((slots, i) => i === 0 || slots.length >= 3)
      .slice(0, 6)
      .map((slots) => {
        const temps = slots.map((s) => s.temp);
        const rep = slots.reduce((best, s) =>
          Math.abs(s.hour - 13) < Math.abs(best.hour - 13) ? s : best
        );
        return {
          slots,
          rep,
          min: Math.min(...temps),
          max: Math.max(...temps),
          pop: Math.max(...slots.map((s) => s.pop))
        };
      });

    return {
      tz,
      sunrise: data.city.sunrise,
      sunset: data.city.sunset,
      days
    };
  }

  // ---------- date and icon formatting ----------

  clock(dt) {
    return new Date((dt + this.model.tz) * 1000)
      .toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
  }

  shortHour(dt) {
    return new Date((dt + this.model.tz) * 1000)
      .toLocaleTimeString('en-IN', { hour: 'numeric', timeZone: 'UTC' });
  }

  weekday(dt, style = 'short') {
    return new Date((dt + this.model.tz) * 1000)
      .toLocaleDateString('en-IN', { weekday: style, timeZone: 'UTC' });
  }

  dayMonth(dt) {
    return new Date((dt + this.model.tz) * 1000)
      .toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  }

  dayName(index, style = 'short') {
    if (index === 0) return 'Today';
    return this.weekday(this.model.days[index].slots[0].dt, style);
  }

  iconClass(code) {
    const night = code.endsWith('n');
    const map = {
      '01': night ? 'fa-moon' : 'fa-sun',
      '02': night ? 'fa-cloud-moon' : 'fa-cloud-sun',
      '03': 'fa-cloud',
      '04': 'fa-cloud',
      '09': 'fa-cloud-showers-heavy',
      '10': night ? 'fa-cloud-moon-rain' : 'fa-cloud-sun-rain',
      '11': 'fa-cloud-bolt',
      '13': 'fa-snowflake',
      '50': 'fa-smog'
    };
    return `fa-solid ${map[code.slice(0, 2)] || 'fa-cloud'}`;
  }

  skyFor(code) {
    if (code.endsWith('n')) return 'night';
    const kind = code.slice(0, 2);
    if (kind === '01') return 'clear';
    if (kind === '02' || kind === '03' || kind === '04') return 'clouds';
    if (kind === '09' || kind === '10') return 'rain';
    if (kind === '11') return 'storm';
    if (kind === '13') return 'snow';
    return 'mist';
  }

  // ---------- rendering ----------

  mount() {
    $('weatherContent').innerHTML = `
      <article class="hero enter" id="hero"></article>
      <div class="days" id="days" role="group" aria-label="Choose a day"></div>
      <section class="hourly" aria-labelledby="hourlyTitle">
        <h3 id="hourlyTitle"></h3>
        <div class="hourly-scroll" id="hourly"></div>
      </section>
    `;
    this.renderAll();
    this.showView('content');
  }

  renderAll() {
    this.renderHero();
    this.renderDays();
    this.renderHourly();
  }

  selectDay(index) {
    if (index === this.dayIndex || !this.model.days[index]) return;
    const day = this.model.days[index];
    $('hero').classList.remove('enter');
    this.dayIndex = index;
    // today starts at the first reading, other days at midday
    this.slotIndex = index === 0 ? 0 : day.slots.indexOf(day.rep);
    this.renderAll();
  }

  selectSlot(index) {
    if (index === this.slotIndex) return;
    $('hero').classList.remove('enter');
    this.slotIndex = index;
    this.renderHero();
    this.renderHourly();
  }

  renderHero() {
    const day = this.model.days[this.dayIndex];
    const s = day.slots[this.slotIndex];
    const hero = $('hero');
    const sym = this.unit === 'metric' ? 'C' : 'F';

    hero.dataset.sky = this.skyFor(s.icon);

    let facts = `
      <div><dt>Feels like</dt><dd>${this.temp(s.feels)}°</dd></div>
      <div><dt>Humidity</dt><dd>${s.humidity}%</dd></div>
      <div><dt>Wind</dt><dd>${this.speed(s.wind)} ${COMPASS[Math.round(s.deg / 45) % 8]}</dd></div>
      <div><dt>Chance of rain</dt><dd>${Math.round(s.pop * 100)}%</dd></div>
      <div><dt>Pressure</dt><dd>${s.pressure} hPa</dd></div>
      <div><dt>Visibility</dt><dd>${this.distance(s.visibility)}</dd></div>
    `;

    // sunrise and sunset only make sense for the current day
    if (this.dayIndex === 0) {
      facts += `
        <div><dt>Sunrise</dt><dd>${this.clock(this.model.sunrise)}</dd></div>
        <div><dt>Sunset</dt><dd>${this.clock(this.model.sunset)}</dd></div>
      `;
    }

    hero.innerHTML = `
      <div class="hero-main">
        <h2 class="place">${esc(this.model.label)}</h2>
        <p class="when">${this.dayName(this.dayIndex, 'long')}, ${this.clock(s.dt)}</p>
        <div class="reading">
          <i class="${this.iconClass(s.icon)}" aria-hidden="true"></i>
          <span class="temp">${this.temp(s.temp)}<span class="deg">°${sym}</span></span>
        </div>
        <p class="cond">${esc(s.desc)}</p>
        <p class="range">
          <span>High ${this.temp(day.max)}°</span>
          <span>Low ${this.temp(day.min)}°</span>
        </p>
      </div>
      <dl class="facts">${facts}</dl>
    `;

  }

  renderDays() {
    $('days').innerHTML = this.model.days.map((day, i) => `
      <button type="button" class="day" data-day="${i}" aria-pressed="${i === this.dayIndex}">
        <span class="day-name">${this.dayName(i)}</span>
        <span class="day-date">${this.dayMonth(day.slots[0].dt)}</span>
        <i class="${this.iconClass(day.rep.icon)}" aria-hidden="true"></i>
        <span class="day-temps">${this.temp(day.max)}°<span>${this.temp(day.min)}°</span></span>
      </button>
    `).join('');
  }

  renderHourly() {
    const day = this.model.days[this.dayIndex];
    const slots = day.slots;
    const colWidth = 84;
    const height = 56;
    const pad = 10;

    $('hourlyTitle').textContent = `${this.dayName(this.dayIndex, 'long')}, every 3 hours`;

    // temperature line drawn above the columns
    const temps = slots.map((s) => s.temp);
    const lo = Math.min(...temps);
    const hi = Math.max(...temps);
    const points = slots.map((s, i) => ({
      x: i * colWidth + colWidth / 2,
      y: pad + (hi === lo ? (height - 2 * pad) / 2 : ((hi - s.temp) / (hi - lo)) * (height - 2 * pad))
    }));

    const path = points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const dots = points
      .map((p, i) => `<circle class="dot${i === this.slotIndex ? ' on' : ''}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${i === this.slotIndex ? 5 : 3.5}"/>`)
      .join('');

    const columns = slots.map((s, i) => {
      const rain = Math.round(s.pop * 100);
      return `
        <button type="button" class="slot" data-slot="${i}" aria-pressed="${i === this.slotIndex}">
          <span class="slot-time">${this.shortHour(s.dt)}</span>
          <i class="${this.iconClass(s.icon)}" aria-hidden="true"></i>
          <span class="slot-temp">${this.temp(s.temp)}°</span>
          <span class="slot-rain">${rain >= 10 ? rain + '%' : ''}</span>
        </button>`;
    }).join('');

    $('hourly').innerHTML = `
      <div class="track" style="--n:${slots.length}">
        <svg width="${slots.length * colWidth}" height="${height}" viewBox="0 0 ${slots.length * colWidth} ${height}" aria-hidden="true">
          <path class="line" d="${path}"/>
          ${dots}
        </svg>
        ${columns}
      </div>
    `;
  }

  // ---------- view state, messages, recent places ----------

  showView(name) {
    $('emptyState').hidden = name !== 'empty';
    $('loadingState').hidden = name !== 'loading';
    $('weatherContent').hidden = name !== 'content';
  }

  showMessage(text) {
    const box = $('errorContainer');
    box.textContent = text;
    clearTimeout(this.messageTimer);
    this.messageTimer = setTimeout(() => {
      box.textContent = '';
    }, 7000);
  }

  remember(place, label) {
    const entry = { ...place, label };
    this.recent = [entry, ...this.recent.filter((p) => p.label !== label)].slice(0, 5);
    store.set('recentPlaces', this.recent);
    this.renderRecent();
  }

  renderRecent() {
    $('recentWrap').hidden = this.recent.length === 0;
    $('recentList').innerHTML = this.recent
      .map((p, i) => `<li><button type="button" data-recent="${i}">${esc(p.label)}</button></li>`)
      .join('');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new WeatherApp();
});
