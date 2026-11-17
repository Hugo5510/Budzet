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

**Aktualizacje:** po każdej zmianie plików podbij `VERSION` w `sw.js` (np. `budzet-v1.1.1`). Wtedy telefony pobiorą nową wersję. Pojawi się ona przy drugim uruchomieniu aplikacji.

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

Raz w miesiącu, przy uruchomieniu, aplikacja przypomina o kopii, jeśli od ostatniej minęło ponad 30 dni.

Dane są tylko w przeglądarce telefonu. Wyczyszczenie danych przeglądarki albo odinstalowanie aplikacji je usuwa, więc rób kopię regularnie.

## Dług z wydatku („ktoś mi to odda”)

W formularzu wydatku zaznacz **Ktoś mi to odda**, wpisz osobę i (opcjonalnie) kwotę do zwrotu oraz termin. Cały wydatek liczy się w statystykach, a w zakładce Długi pojawia się wpis „Mi są winni”. Wydatek liczy się w całości od razu, a każda spłata długu pomniejsza wydatki (w kategorii oryginalnego wydatku, w okresie spłaty) i podnosi bilans o oddaną kwotę. Spłata korków nadal nie jest przychodem. Usunięcie wydatku usuwa też powiązany dług (aplikacja pyta o potwierdzenie).

## Subskrypcje z dłużnikami

W formularzu subskrypcji możesz dodać kilka osób, które Ci za nią oddają (osoba + kwota za jeden cykl). Przy każdym pobraniu powstaje wydatek i dług „Mi są winni” dla każdej z nich. Spłata działa tak samo jak przy zwykłym długu z wydatku. Zmiana listy dłużników dotyczy kolejnych pobrań, a już utworzone długi zostają.

## Synchronizacja telefon ↔ komputer (GitHub)

Dane trafiają do **prywatnego** repozytorium na Twoim koncie GitHub (jeden plik `budzet-dane.json`). Serwera pośredniego nie ma. Zdjęcia paragonów zostają na urządzeniu, a odczytane z nich pozycje się synchronizują. Dane demo, klucz API i token nie są wysyłane.

**Konfiguracja (raz):**
1. Na github.com utwórz **prywatne** repozytorium, np. `budzet-dane` (zaznacz *Add a README file*).
2. Wejdź na <https://github.com/settings/personal-access-tokens/new>:
   *Repository access → Only select repositories* → wybierz to repo → *Permissions → Repository permissions → Contents: Read and write* → *Generate token* i skopiuj go (widać go tylko raz).
3. W aplikacji: **Ustawienia → Synchronizacja** → wpisz `login/budzet-dane` i token → *Połącz i synchronizuj*.
4. Na drugim urządzeniu zrób to samo (to samo repo, ten sam token). Przed połączeniem możesz wyczyścić dane demo.

**Jak działa:** zmiany wysyłają się kilka sekund po zapisie oraz przy otwarciu aplikacji i powrocie sieci, a przycisk *Synchronizuj teraz* robi to od ręki. Gdy ten sam wpis zmienisz na obu urządzeniach, wygrywa nowsza zmiana. Usunięcie na jednym urządzeniu usuwa wpis na drugim. Pobrania subskrypcji nie dublują się. Offline wszystko działa, a synchronizacja nadrabia się po powrocie internetu.

**Uwagi:**
- Token jest zapisany tylko na urządzeniu (jak klucz API) i daje dostęp wyłącznie do tego jednego repozytorium. Jeśli go zgubisz lub wyciekł, usuń go w ustawieniach GitHuba i utwórz nowy.
- *Importuj kopię (JSON)* jest nadrzędny: po imporcie ten stan trafi też na drugie urządzenie.
- Fine-grained token ma datę ważności (maks. rok). Po wygaśnięciu aplikacja pokaże „Token jest nieprawidłowy lub wygasł”. Utwórz nowy i wklej go w Ustawieniach.

## Dane demo

Przy pierwszym uruchomieniu wczytują się przykładowe dane. Usuwa je przycisk **Wyczyść demo** na ekranie Wydatki (albo w Ustawieniach). Twoje własne wpisy zostają.

## Struktura

```
index.html        – szkielet, pływający pasek zakładek, wbudowane ikony (Phosphor Icons, MIT)
manifest.json     – manifest PWA (standalone, ikony 192/512/maskable)
sw.js             – service worker (cache całej aplikacji)
css/style.css     – style (szata 2.0), tryb jasny/ciemny, safe-area
js/app.js         – widoki i logika UI
js/db.js          – IndexedDB
js/util.js        – kwoty, daty, okresy statystyk, terminy subskrypcji
js/charts.js      – wykresy SVG (kołowy, słupkowy)
js/receipt.js     – zmniejszanie zdjęcia i wywołanie API Anthropic
js/sync.js        – synchronizacja przez prywatne repo GitHub (scalanie, API)
js/demo.js        – kategorie domyślne i dane demo
icons/            – ikony aplikacji
```

Lokalny podgląd: `python3 -m http.server 8000` w tym folderze → <http://localhost:8000>. Service worker działa na `localhost` i pod HTTPS.
