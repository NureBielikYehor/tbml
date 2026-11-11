"""Build and execute the required Jupyter EDA, keeping aggregate figures in reports/."""
from __future__ import annotations
import os
import subprocess
import sys
from pathlib import Path
import nbformat as nbf
from nbclient import NotebookClient

ROOT = Path(__file__).resolve().parents[1]


def main():
    notebook = nbf.v4.new_notebook()
    cells = []
    def md(text): cells.append(nbf.v4.new_markdown_cell(text))
    def code(text): cells.append(nbf.v4.new_code_cell(text))
    md("""# Первинний аналіз Kickstarter для tbml

Автори проєкту: Бєлік Єгор і Глоба Максим, ПЗПІ-23-6.

Прогнозуємо досягнення цілі збору за параметрами, відомими до старту. Основне джерело — Kickstarter Projects (Mickaël Mouillé, CC BY-NC-SA 4.0). Короткі описи `blurb` приєднуємо за ID із фіксованого знімка Web Robots 2018-01-12. Їхню незмінність із моменту запуску не підтверджено; явна ліцензія повторного використання цього знімка не знайдена. Сирі тексти не публікуються в Git.

Мітка успіху не означає виконання проєкту. Назви кампаній не підміняють описи. `pledged`, `backers`, фінальний стан та похідні від фінансового результату заборонені як входи ML.""")
    code("""from pathlib import Path
import json, sys
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from IPython.display import display, Markdown, Image
ROOT = Path.cwd()
if not (ROOT / 'ml').exists(): ROOT = ROOT.parent
sys.path.insert(0, str(ROOT))
from ml.features import load_campaigns, temporal_split, training_features
FIG = ROOT / 'reports/figures'
FIG.mkdir(parents=True, exist_ok=True)
plt.rcParams.update({'figure.figsize': (9, 4.5), 'font.size': 10, 'axes.spines.top': False, 'axes.spines.right': False})
def show(name):
    plt.tight_layout(); plt.savefig(FIG / (name + '.png'), dpi=150, bbox_inches='tight')
    display(Image(filename=str(FIG / (name + '.png')))); plt.close()
raw = pd.read_csv(ROOT / 'data/raw/ks-projects-201801.csv', dtype={'ID': 'string'})
data, audit = load_campaigns(ROOT / 'data/raw/ks-projects-201801.csv', ROOT / 'data/raw/descriptions.csv')
source = json.loads((ROOT / 'reports/data/kickstarter-audit.json').read_text())
display(Markdown(f"**Розмір:** {len(raw):,} кампаній, {len(raw.columns)} колонок. Після відбору міток і перевірки чисел/дат: {len(data):,}. SHA-256 CSV: `{source['sha256']}`."))
display(raw.dtypes.astype(str).rename('тип').to_frame())""")
    md("## Словник ознак і момент доступності")
    code("""roles = {
 'ID': 'ID для зіставлення та дедуплікації; не прогнозна ознака',
 'name': 'Назва; не використовується як опис або ML-вхід',
 'category': 'Категорія на старті; категоріальна ознака',
 'main_category': 'Головна категорія на старті',
 'currency': 'Валюта цілі, відома на старті',
 'deadline': 'Планований дедлайн; для тривалості й очищення часових меж',
 'goal': 'Заявлена ціль у вихідній валюті; використовуємо log1p разом із валютою',
 'launched': 'Запуск: календарні ознаки та хронологічна валідація',
 'pledged': 'Зібрані кошти: ЗАБОРОНЕНО, відомі після старту',
 'state': 'Фінальна мітка, лише y: successful=1, failed=0',
 'backers': 'Кількість вкладників: ЗАБОРОНЕНО, відома після старту',
 'country': 'Країна автора, категоріальна ознака',
 'usd pledged': 'Зібрані кошти: ЗАБОРОНЕНО',
 'usd_pledged_real': 'Зібрані кошти: ЗАБОРОНЕНО',
 'usd_goal_real': 'Не використовуємо: момент визначення курсу не підтверджений',
 'blurb': 'Окреме джерело: справжній короткий опис, походження до запуску не доведено'}
display(pd.DataFrame([{'ознака': key, 'значення та політика': value} for key,value in roles.items()]))
catalog = {'categories': raw[['category','main_category']].dropna().drop_duplicates().sort_values(['main_category','category']).to_dict('records'),
           'currencies': sorted(raw.currency.dropna().unique().tolist()),
           'countries': sorted([v for v in raw.country.dropna().unique() if len(v)==2 and v.isalpha()])}
(ROOT / 'reports/data/catalog.json').write_text(json.dumps(catalog, ensure_ascii=False, indent=2))""")
    md("## Рисунок 1 Стани кампаній і баланс цільових класів")
    code("""counts = raw.state.value_counts()
counts.plot.bar(color='#335c48'); plt.ylabel('Кількість кампаній'); plt.xlabel('Стан кампанії'); plt.xticks(rotation=25)
show('01-class-balance')
p = data.state.eq('successful').mean()
display(Markdown(f'Висновок: частка успіху серед successful/failed — **{p:.2%}**. Класи незбалансовані, тому accuracy недостатньо; оцінюємо F1, ROC-AUC, PR-AUC і калібрування. Незавершені й скасовані кампанії не прирівнюємо автоматично до failed.'))""")
    md("## Рисунок 2 Розподіл цілі збору в доларах США")
    code("""usd = data.loc[data.currency.eq('USD'), 'goal']
np.log10(usd).hist(bins=60, color='#335c48'); plt.xlabel('log10 цілі, USD'); plt.ylabel('Кількість кампаній')
show('02-goal-distribution')
display(Markdown(f'Висновок: медіана цілі в USD — **{usd.median():,.0f}**, 99-й процентиль — **{usd.quantile(.99):,.0f}**. Цілі мають довгий хвіст; використовуємо log1p. Для цього графіка обрано лише USD, щоб не змішувати різні валюти.'))""")
    md("## Рисунок 3 Запланована тривалість збору")
    code("""duration = (data.deadline-data.launched).dt.total_seconds()/86400
duration[duration.le(120)].hist(bins=60, color='#335c48'); plt.xlabel('Тривалість збору, днів (для показу до 120)'); plt.ylabel('Кількість кампаній')
show('03-duration')
display(Markdown(f'Висновок: медіана тривалості — **{duration.median():.1f} днів**, понад 120 днів мають **{duration.gt(120).sum()}** кампаній. Наддовгі та помилкові дати потребують окремого аналізу; позитивні значення автоматично не обрізаємо за тестовими даними.'))""")
    md("## Рисунок 4 Пропуски в початковому наборі")
    code("""missing = raw.isna().mean().mul(100)
missing.plot.bar(color='#b68648'); plt.ylabel('Пропуски, %'); plt.xlabel('Ознака'); plt.xticks(rotation=55, ha='right')
show('04-missing')
display(Markdown(f'Висновок: у name пропущено **{raw.name.isna().sum()}**, у usd pledged — **{raw["usd pledged"].isna().sum()}** значень. Ці поля не є входами поточних моделей; для допустимих числових входів imputer навчається лише на train.'))""")
    md("## Рисунок 5 Залежності між допустимими ознаками та міткою")
    code("""X = training_features(data)
corr_data = X[['goal_log','duration_days','launch_month','launch_weekday']].copy()
corr_data['description_length'] = data.description.str.len()
corr_data['target_EDA_only'] = data.state.eq('successful').astype(int)
corr = corr_data.corr()
fig, ax = plt.subplots(figsize=(8,6)); image=ax.imshow(corr, vmin=-1,vmax=1,cmap='RdBu_r')
ax.set_xticks(range(len(corr)), corr.columns, rotation=40, ha='right'); ax.set_yticks(range(len(corr)), corr.columns)
for i in range(len(corr)):
 for j in range(len(corr)): ax.text(j,i,f'{corr.iloc[i,j]:.2f}',ha='center',va='center',fontsize=8)
fig.colorbar(image,ax=ax,label='Кореляція Пірсона'); show('05-correlations')
display(Markdown('Висновок: кореляції описують лінійні залежності й не доводять причинності. Стовпець target додано лише для EDA; він не передається до ML-конвеєра. Відсутність сильної кореляції не означає відсутності нелінійного сигналу.'))""")
    md("## Рисунок 6 Викиди цілі збору")
    code("""plt.boxplot([usd[data.loc[usd.index,'state'].eq(s)] for s in ['failed','successful']], tick_labels=['Неуспішні','Успішні'], showfliers=True)
plt.yscale('log'); plt.ylabel('Ціль у USD, логарифмічна шкала'); plt.xlabel('Фінальний клас')
show('06-outliers')
q1,q3=usd.quantile([.25,.75]); outliers=(usd.gt(q3+1.5*(q3-q1))).sum()
display(Markdown(f'Висновок: за верхньою межею 1.5 IQR в USD — **{outliers:,}** кампаній. Частина великих цілей реальна; не видаляємо їх лише через відхилення від медіани. Використовуємо логарифмування й перевіряємо помилки чисел/дат.'))""")
    md("## Рисунок 7 Зміна потоку кампаній у часі")
    code("""timeline=data.groupby(data.launched.dt.to_period('M').astype(str)).agg(n=('ID','size'),success=('state',lambda v:v.eq('successful').mean()))
fig,ax=plt.subplots(); ax.plot(range(len(timeline)),timeline.n,color='#335c48',label='Кампанії')
indices=np.linspace(0,len(timeline)-1,8).astype(int); ax.set_xticks(indices,timeline.index[indices],rotation=25)
ax.set_xlabel('Місяць запуску'); ax.set_ylabel('Кількість кампаній')
ax2=ax.twinx(); ax2.plot(range(len(timeline)),timeline.success,color='#b68648',alpha=.7); ax2.set_ylabel('Частка успіху'); show('07-timeline')
display(Markdown(f'Висновок: дані охоплюють запуски від **{data.launched.min().date()}** до **{data.launched.max().date()}**. Розподіл змінюється в часі, тому основний split — хронологічний; результат навчальної кампанії має бути відомий до початку наступного періоду.'))""")
    md("## Рисунок 8 Покриття справжніми короткими описами")
    code("""coverage=data.assign(has_text=data.description.str.strip().ne('')).groupby('state').has_text.mean().mul(100)
coverage.plot.bar(color=['#b68648','#335c48']); plt.ylabel('Кампанії з приєднаним описом, %'); plt.xlabel('Клас'); plt.xticks(rotation=0); plt.ylim(0,100)
show('08-description-coverage')
display(Markdown(f'Висновок: приєднано **{data.description.str.strip().ne("").sum():,}** непорожніх описів за ID. Покриття може залежати від класу й року; усі три методи порівнюємо на однаковій підмножині з текстом. Походження текстів до запуску не доведено, тому результати є ретроспективними.'))""")
    md("## Схема валідації та підсумкові рішення")
    code("""cohort=data[data.description.str.strip().ne('')].reset_index(drop=True)
parts,split=temporal_split(cohort)
display(pd.DataFrame([{'частина':k,'рядків':len(v),'від':str(v.launched.min().date()),'до':str(v.launched.max().date()),'успіх':v.state.eq('successful').mean()} for k,v in parts.items()]))
display(Markdown(f'На часових межах вилучено **{split["purged_boundary_rows"]:,}** кампаній, результат яких ще не був би відомий до наступного періоду. Усі перетворення fit лише на train. Поріг класифікації та вибір моделі визначаються validation, фінальні метрики — на відкладеному test.'))
summary={**audit,'split':split,'source_sha256':source['sha256'],'missing':raw.isna().sum().to_dict(),'duplicate_ids':int(raw.ID.duplicated().sum())}
(ROOT/'reports/data/eda-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
display(Markdown('Підсумок: не змішуємо валюти без їх коду; трансформуємо довгий хвіст цілей; не використовуємо фінансовий результат як ознаки; враховуємо часові межі доступності міток; окремо звітуємо про неповне текстове покриття, невідомі умови повторного використання знімка та можливе редагування описів.'))""")
    notebook.cells = cells
    notebook.metadata.kernelspec = {"display_name": "Python (tbml)", "language": "python", "name": "tbml"}
    folder = ROOT / "notebooks"
    folder.mkdir(exist_ok=True)
    subprocess.run([sys.executable, "-m", "ipykernel", "install", "--prefix", str(ROOT/".venv"), "--name", "tbml", "--display-name", "Python (tbml)"], check=True)
    os.environ["JUPYTER_PATH"] = str(ROOT/".venv/share/jupyter")
    NotebookClient(notebook, timeout=300, kernel_name="tbml", resources={"metadata": {"path": str(ROOT)}}).execute()
    nbf.write(notebook, folder / "01_kickstarter_eda.ipynb")
    print("Executed notebook saved; 8 figures in reports/figures", flush=True)


if __name__ == "__main__":
    main()
