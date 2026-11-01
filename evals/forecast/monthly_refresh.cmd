@echo off
rem Monthly refresh of the price ranges (markets.price_outlook). Run by the Windows scheduled task "CriticalMinerals-PriceOutlook-Monthly" on the 5th at 08:00.
rem Writes only when a newer common price month exists; appends to evals\forecast\monthly_refresh.log. Needs the IMF / World Bank price tables to have been refreshed first.
rem The task environment does not always include the user's site-packages (numpy, psycopg2), so it is put on the path explicitly.
set PYTHONPATH=C:\Users\dean\AppData\Roaming\Python\Python314\site-packages
cd /d C:\Users\dean\critical-minerals-ai
echo ===== %DATE% %TIME% user=%USERNAME% appdata=%APPDATA% >> evals\forecast\monthly_refresh.log
C:\Python314\python.exe -c "import sys,os;print('sys.path',sys.path);print(os.path.isdir(r'C:\Users\dean\AppData\Roaming\Python\Python314\site-packages\numpy'))" >> evals\forecast\monthly_refresh.log 2>&1
C:\Python314\python.exe evals\forecast\publish_outlook.py --if-new >> evals\forecast\monthly_refresh.log 2>&1
echo exit code %ERRORLEVEL% >> evals\forecast\monthly_refresh.log
