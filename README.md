# Budżet – PWA do budżetu osobistego

Aplikacja w przeglądarce, projektowana pod telefon: wydatki, przychody, statystyki, długi (z korepetycjami), subskrypcje i skan paragonów przez API Anthropic. Kwoty są w PLN. Działa offline, a dane trzyma lokalnie w IndexedDB, bez kont i bez serwera.

Czysty HTML + CSS + JS (moduły ES), bez kroku budowania. Wrzucasz pliki na dowolny statyczny hosting z HTTPS.

## Wdrożenie na GitHub Pages

1. Utwórz nowe repozytorium na GitHubie (np. `budzet`).
2. Wgraj **zawartość** tego folderu do głównego katalogu repo (tak, żeby `index.html` był w korzeniu):
   - przez stronę: *Add file → Upload files* → przeciągnij wszystkie pliki i foldery (`css`, `js`, `icons`) → *Commit*,
   - albo z terminala:
     ```bash
     git init && git add . && git commit -m "Budżet PWA"
     git branch -M main
     git remote add origin https://github.com/TWOJ_LOGIN/budzet.git
     git push -u origin main
     ```
3. W repo: *Settings → Pages → Build and deployment → Source: Deploy from a branch*, wybierz `main` i `/ (root)`, potem *Save*.
4. Po minucie aplikacja będzie pod adresem `https://TWOJ_LOGIN.github.io/budzet/`.

Ścieżki w aplikacji są względne, więc działa też w podkatalogu. Na Netlify wystarczy przeciągnąć folder na app.netlify.com/drop.

**Aktualizacje:** po każdej zmianie plików podbij `VERSION` w `sw.js` (np. `budzet-v1.0.1`). Wtedy telefony pobiorą nową wersję. Pojawi się ona przy drugim uruchomieniu aplikacji.

## Dodanie do ekranu głównego

**Android (Chrome):** otwórz adres aplikacji → menu **⋮** → **Zainstaluj aplikację** (lub *Dodaj do ekranu głównego*). Chrome może też sam pokazać baner instalacji.

**iPhone / iPad (Safari):** otwórz adres w **Safari** → przycisk **Udostępnij** (kwadrat ze strzałką) → **Do ekranu początkowego** → *Dodaj*. Na iOS instalacja działa tylko z Safari.

Po instalacji aplikacja otwiera się na pełnym ekranie i działa bez internetu. Internet jest potrzebny tylko do skanu paragonów.

## Skan paragonów

1. Utwórz klucz API na <https://console.anthropic.com> (*API Keys*). Potrzebne są środki na koncie API.
2. W aplikacji: **Ustawienia → Klucz API** → wklej klucz. Domyślny model to `claude-haiku-5-5` (można zmienić).
3. Przycisk aparatu → zdjęcie lub galeria → ekran weryfikacji → zapis jako jeden wydatek albo osobno wg kategorii.

Klucz jest zapisany tylko w IndexedDB na tym urządzeniu i wysyłany wyłącznie do `api.anthropic.com`. Wywołanie idzie prosto z przeglądarki z nagłówkiem `anthropic-dangerous-direct-browser-access: true`. Klucz nie trafia do eksportu JSON. Nie udostępniaj innym swojej zainstalowanej kopii z wpisanym kluczem.

## Kopia zapasowa

**Ustawienia → Dane:**
- *Eksportuj kopię (JSON)*: wszystko, łącznie ze zdjęciami paragonów. *Importuj* zastępuje obecne dane.
- *Eksportuj wydatki (CSV)*: separator `;` i przecinek dziesiętny, plik otwiera się poprawnie w polskim Excelu.

Dane są tylko w przeglądarce telefonu. Wyczyszczenie danych przeglądarki albo odinstalowanie aplikacji je usuwa, więc rób kopię regularnie.

## Dane demo

Przy pierwszym uruchomieniu wczytują się przykładowe dane. Usuwa je przycisk **Wyczyść demo** na ekranie Wydatki (albo w Ustawieniach). Twoje własne wpisy zostają.

## Struktura

```
index.html        – szkielet, dolny pasek nawigacji
manifest.json     – manifest PWA (standalone, ikony 192/512/maskable)
sw.js             – service worker (cache całej aplikacji)
css/style.css     – style, tryb jasny/ciemny, safe-area
js/app.js         – widoki i logika UI
js/db.js          – IndexedDB
js/util.js        – kwoty, daty, okresy statystyk, terminy subskrypcji
js/charts.js      – wykresy SVG (kołowy, słupkowy)
js/receipt.js     – zmniejszanie zdjęcia i wywołanie API Anthropic
js/demo.js        – kategorie domyślne i dane demo
icons/            – ikony aplikacji
```

Lokalny podgląd: `python3 -m http.server 8000` w tym folderze → <http://localhost:8000>. Service worker działa na `localhost` i pod HTTPS.
