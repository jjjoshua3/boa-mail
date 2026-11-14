# Mail · BOA Portaal

Webmail voor mail.boaportaal.nl.

Inloggen gebeurt op de echte postbus. Het wachtwoord van iemand anders opent die postbus niet. Support, info en account zijn geen login.

Gedeelde postbussen leest de server met een eigen sleutel. Die sleutels staan alleen als omgevingsvariabelen, niet in deze code:

- `SESSION_SECRET`
- `PURELYMAIL_SUPPORT_PASSWORD`
- `PURELYMAIL_INFO_PASSWORD`
- `PURELYMAIL_ACCOUNT_PASSWORD`

Account is alleen zichtbaar voor joshua.bosma en beheerder.
