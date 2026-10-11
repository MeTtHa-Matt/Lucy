#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
COLOR=0
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then COLOR=1; fi

paint() {
  local color="$1" text="$2"
  if ((COLOR)); then printf '\033[%sm%s\033[0m' "$color" "$text"; else printf '%s' "$text"; fi
}

render() {
  local stage="$1" detail="$2"
  stage="${stage:0:56}"
  detail="${detail:0:56}"
  if [[ -t 1 ]]; then printf '\033[2J\033[H'; fi
  printf '\n'
  paint '31;1' '  ╔══════════════════════════════════════════════════════════════╗'; printf '\n'
  paint '31;1' '  ║'; paint '97;1' '  L'; paint '95;1' ' U C Y'; paint '90' '  /  NEURAL INSTALLER'; paint '31;1' '                             ║'; printf '\n'
  paint '31;1' '  ╠══════════════════════════════════════════════════════════════╣'; printf '\n'
  paint '31;1' '  ║'; paint '97;1' "  $stage"; printf '%*s' "$((58 - ${#stage}))" ''; paint '31;1' '║'; printf '\n'
  paint '31;1' '  ║'; paint '90' "  $detail"; printf '%*s' "$((58 - ${#detail}))" ''; paint '31;1' '║'; printf '\n'
  paint '31;1' '  ╚══════════════════════════════════════════════════════════════╝'; printf '\n\n'
  paint '90' '  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'; printf '\n\n'
}

step() {
  render "$1" "$2"
  paint '31;1' '  ◆ '; paint '97' "$3"; printf '\n\n'
}

ask_yes_no() {
  local answer
  paint '31;1' '  ? '; paint '97' "$1"; printf '\n'
  paint '90' '    [o/N] '; read -r answer
  [[ "$answer" =~ ^[oOyY]$ ]]
}

fail() {
  paint '31;1' "\n  ✕ $1\n"; exit 1
}

has_command() { command -v "$1" >/dev/null 2>&1; }

package_installed() {
  case "$1" in
    pacman) pacman -Q "$2" >/dev/null 2>&1 ;;
    apt) dpkg -s "$2" >/dev/null 2>&1 ;;
    dnf) rpm -q "$2" >/dev/null 2>&1 ;;
  esac
}

missing_packages() {
  local manager="$1"; shift
  local package
  local -a missing=()
  for package in "$@"; do
    package_installed "$manager" "$package" || missing+=("$package")
  done
  if ((${#missing[@]})); then
    printf '%s\n' "${missing[@]}"
  fi
}

install_linux_dependencies() {
  local id desktop manager packages=() missing=()
  id="$(. /etc/os-release; printf '%s' "${ID:-unknown}")"
  desktop="${XDG_CURRENT_DESKTOP:-${DESKTOP_SESSION:-inconnu}}"
  step "01  /  ENVIRONNEMENT" "Linux · $id · $desktop" "Détection du système et du bureau graphique"

  case "$id" in
    arch|endeavouros|manjaro)
      manager=pacman
      packages=(base-devel webkit2gtk-4.1 gtk3 libayatana-appindicator librsvg patchelf openssl curl file nodejs npm rustup)
      mapfile -t missing < <(missing_packages "$manager" "${packages[@]}")
      if ((${#missing[@]})); then
        render "02  /  DÉPENDANCES" "Arch Linux · ${#missing[@]} paquet(s) manquant(s)"
        printf '  '; paint '90' "${missing[*]}"; printf '\n\n'
      fi
      if ((${#missing[@]})) && ask_yes_no "Installer les dépendances manquantes avec pacman ?"; then
        sudo pacman -S --needed "${missing[@]}" || fail "pacman n’a pas pu installer les dépendances."
        rustup default stable || fail "Impossible de sélectionner Rust stable."
      elif ((${#missing[@]})); then
        fail "Installation annulée ; aucun paquet système n’a été installé."
      else
        step "02  /  DÉPENDANCES" "Arch Linux · tout est installé" "Aucun paquet système à installer"
        rustup default stable || fail "Impossible de sélectionner Rust stable."
      fi
      ;;
    ubuntu|debian|linuxmint|pop)
      manager=apt
      packages=(build-essential curl file libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf libwebkit2gtk-4.1-dev nodejs npm)
      mapfile -t missing < <(missing_packages "$manager" "${packages[@]}")
      if ((${#missing[@]})); then
        render "02  /  DÉPENDANCES" "Debian/Ubuntu · ${#missing[@]} paquet(s) manquant(s)"
        printf '  '; paint '90' "${missing[*]}"; printf '\n\n'
      fi
      if ((${#missing[@]})) && ask_yes_no "Installer les dépendances manquantes avec apt ?"; then
        sudo apt-get update || fail "Échec de la mise à jour des index apt."
        sudo apt-get install -y "${missing[@]}" || fail "apt n’a pas pu installer les dépendances."
      elif ((${#missing[@]})); then
        fail "Installation annulée ; aucun paquet système n’a été installé."
      else
        step "02  /  DÉPENDANCES" "Debian/Ubuntu · tout est installé" "Aucun paquet système à installer"
      fi
      ;;
    fedora)
      manager=dnf
      packages=(gcc gcc-c++ make curl file openssl-devel libappindicator-gtk3 librsvg2-devel patchelf webkit2gtk4.1-devel nodejs npm)
      mapfile -t missing < <(missing_packages "$manager" "${packages[@]}")
      if ((${#missing[@]})); then
        render "02  /  DÉPENDANCES" "Fedora · ${#missing[@]} paquet(s) manquant(s)"
        printf '  '; paint '90' "${missing[*]}"; printf '\n\n'
      fi
      if ((${#missing[@]})) && ask_yes_no "Installer les dépendances manquantes avec dnf ?"; then
        sudo dnf install -y "${missing[@]}" || fail "dnf n’a pas pu installer les dépendances."
      elif ((${#missing[@]})); then
        fail "Installation annulée ; aucun paquet système n’a été installé."
      else
        step "02  /  DÉPENDANCES" "Fedora · tout est installé" "Aucun paquet système à installer"
      fi
      ;;
    *)
      fail "Distribution Linux « $id » non prise en charge. Prérequis : GTK 3, WebKitGTK 4.1, OpenSSL, Node.js/npm et Rust stable."
      ;;
  esac

  if ! has_command rustup && ! has_command cargo; then
    if ask_yes_no "Rust manque. Installer rustup depuis rustup.rs ?"; then
      curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/lucy-rustup-init || fail "Téléchargement de rustup impossible."
      sh /tmp/lucy-rustup-init -y --default-toolchain stable || fail "L’installation de rustup a échoué."
      rm -f /tmp/lucy-rustup-init
      # shellcheck disable=SC1091
      source "$HOME/.cargo/env"
    else
      fail "Rust est requis pour compiler LUCY."
    fi
  fi
}

install_macos_dependencies() {
  step "01  /  ENVIRONNEMENT" "macOS · bureau Apple" "Détection du système"
  if ! xcode-select -p >/dev/null 2>&1; then
    if ask_yes_no "Les outils de ligne de commande Xcode manquent. Lancer leur installation ?"; then
      xcode-select --install || fail "Impossible de lancer l’installation des outils Xcode."
      fail "Termine l’installation Xcode puis relance scripts/install.sh."
    else
      fail "Les outils Xcode sont requis."
    fi
  fi

  if ! has_command brew; then
    if ask_yes_no "Homebrew manque. L’installer depuis brew.sh ?"; then
      curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o /tmp/lucy-homebrew-install || fail "Téléchargement de Homebrew impossible."
      /bin/bash /tmp/lucy-homebrew-install || fail "L’installation Homebrew a échoué."
      rm -f /tmp/lucy-homebrew-install
      if [[ -x /opt/homebrew/bin/brew ]]; then
        export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"
      elif [[ -x /usr/local/bin/brew ]]; then
        export PATH="/usr/local/bin:/usr/local/sbin:$PATH"
      fi
    else
      fail "Homebrew est nécessaire pour installer les dépendances manquantes."
    fi
  fi

  local packages=()
  has_command node || packages+=(node)
  has_command npm || packages+=(node)
  has_command rustup || has_command cargo || packages+=(rustup-init)
  if ((${#packages[@]})); then
    if ask_yes_no "Installer avec Homebrew : ${packages[*]} ?"; then
      brew install "${packages[@]}" || fail "Homebrew n’a pas pu installer les dépendances."
      if has_command rustup-init && ! has_command rustup; then
        rustup-init -y --default-toolchain stable || fail "L’installation de rustup a échoué."
        # shellcheck disable=SC1091
        source "$HOME/.cargo/env"
      fi
    else
      fail "Installation annulée ; aucun paquet manquant n’a été installé."
    fi
  fi
  if has_command rustup; then rustup default stable || fail "Impossible de sélectionner Rust stable."; fi
}

if [[ "$(uname -s)" == "Darwin" ]]; then
  install_macos_dependencies
elif [[ "$(uname -s)" == "Linux" ]]; then
  if grep -qi microsoft /proc/version 2>/dev/null; then
    step "01  /  ENVIRONNEMENT" "Linux · WSL" "WSLg ou Wayland/X11 est nécessaire pour l’interface"
  fi
  install_linux_dependencies
else
  fail "Système non pris en charge par ce script. Sous Windows, lance scripts/install.bat."
fi

if ! has_command node || ! has_command npm || ! has_command cargo; then
  fail "Dépendance manquante après installation : node, npm et cargo doivent être accessibles dans PATH."
fi

CARGO_TARGET_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/lucy/installer-cargo-target"
export CARGO_TARGET_DIR
mkdir -p "$CARGO_TARGET_DIR" || fail "Impossible de créer le cache de compilation Rust : $CARGO_TARGET_DIR"

step "02  /  PROJET" "npm · Rust · Tauri" "Installation des paquets du projet et compilation"
cd "$ROOT"
npm ci || fail "L’installation des paquets npm a échoué."

if [[ "$(uname -s)" == "Darwin" ]]; then
  npm run tauri -- build --bundles app || fail "La compilation macOS a échoué."
  APP_PATH="$CARGO_TARGET_DIR/release/bundle/macos/LUCY Neural Interface.app"
  mkdir -p "$HOME/Applications"
  cp -R "$APP_PATH" "$HOME/Applications/" || fail "Impossible d’installer l’application dans ~/Applications."
  INSTALL_PATH="$HOME/Applications/LUCY Neural Interface.app"
else
  npm run tauri -- build --no-bundle || fail "La compilation Linux a échoué."
  install -Dm755 "$CARGO_TARGET_DIR/release/lucy" "$HOME/.local/bin/lucy" || fail "Impossible d’installer LUCY dans ~/.local/bin."
  install -Dm644 "$ROOT/lucy.desktop" \
    "${XDG_DATA_HOME:-$HOME/.local/share}/applications/lucy.desktop" \
    || fail "Impossible de créer le raccourci LUCY dans le menu des applications."
  install -Dm644 "$ROOT/src-tauri/icons/icon.png" \
    "${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/256x256/apps/lucy.png" \
    || fail "Impossible d’installer l’icône du raccourci LUCY."
  INSTALL_PATH="$HOME/.local/bin/lucy"
fi

DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/com.lucy.neural"
if [[ "$(uname -s)" == "Darwin" ]]; then
  DATA_DIR="$HOME/Library/Application Support/com.lucy.neural"
fi
STORE_PATH="$DATA_DIR/lucy.json"
SAVED_NAME="$(node -e 'const fs=require("fs");try{process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).userName||"")}catch{}' "$STORE_PATH")"
if [[ -z "$SAVED_NAME" ]]; then
  render "03  /  TON PROFIL" "Ce prénom reste sur cet ordinateur"
  while true; do
    paint '31;1' '  ? '; paint '97' 'Comment tu t’appelles ? (prénom ou surnom) '; read -r USER_NAME
    USER_NAME="${USER_NAME#"${USER_NAME%%[![:space:]]*}"}"
    USER_NAME="${USER_NAME%"${USER_NAME##*[![:space:]]}"}"
    if [[ -n "$USER_NAME" && "${#USER_NAME}" -le 60 && "$USER_NAME" != *$'\n'* && "$USER_NAME" != *$'\r'* ]]; then break; fi
    paint '31' '  Entre un prénom/surnom de 1 à 60 caractères.'; printf '\n'
  done
  mkdir -p "$DATA_DIR"
  node -e 'const fs=require("fs");const p=process.argv[1];const n=process.argv[2];fs.writeFileSync(p,JSON.stringify({userName:n}),{mode:0o600})' \
    "$DATA_DIR/lucy-initial-profile.json" "$USER_NAME" || fail "Impossible d’enregistrer le prénom localement."
else
  USER_NAME="$SAVED_NAME"
fi

render "04  /  TERMINÉ" "LUCY · installation prête"
paint '92;1' '  ✓ '; paint '97' "Installée : $INSTALL_PATH"; printf '\n'
paint '90' "  Salut $USER_NAME — ton prénom est enregistré localement."; printf '\n'
paint '90' '  Lance LUCY : la première conversation est prête.'; printf '\n\n'
if [[ -t 0 ]]; then read -r -p "  Entrée pour quitter…"; fi
