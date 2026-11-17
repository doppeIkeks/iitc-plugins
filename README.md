# IITC-Plugins

## MU Info (`mu-labels.user.js`)

Fügt links auf der Intel-Karte einen **MU**-Button hinzu. Ist der Info-Modus an, zeigt ein Klick auf ein Feld oder Draw-Tools-Dreieck die geschätzte MU jedes Layers in einem Popup.

**Wasabee:** Der Toolbox-Link „MU Wasabee“ liest die gewählte Wasabee-Operation direkt aus, ohne Export oder Import. Er zeigt die Gesamt-MU aller Felder, die die Links in ihrer Wasabee-Reihenfolge erzeugen. Pro Link und Seite zählt nur das größte Dreieck, weitere sind leere Felder. Wasabee-Felder erscheinen auch im Klick-Popup.

**Installation:** [mu-labels.user.js](https://raw.githubusercontent.com/doppeIkeks/iitc-plugins/main/mu-labels.user.js) in Tampermonkey/Violentmonkey oder in IITC-CE (Mobile) öffnen. Updates kommen automatisch über `@updateURL`.

Standard-Server ist `https://miokij.de/mu`; über den Toolbox-Link „MU Info“ lässt sich ein anderer eintragen. Ein MU-Server braucht diese Endpunkte:
- `GET /api/getMU?c=lat,lng&c=…&c=…`
- `POST /api/getMUbulk` mit `{"fields": [["lat,lng", "lat,lng", "lat,lng"], …]}` (max. 50)

Außerdem muss er CORS für `https://intel.ingress.com` erlauben.

### Neue Version veröffentlichen
1. `@version` in `mu-labels.user.js` erhöhen.
2. Den Header in `mu-labels.meta.js` aktualisieren: `sed -n '1,/==\/UserScript==/p' mu-labels.user.js > mu-labels.meta.js`
3. Committen und pushen.
